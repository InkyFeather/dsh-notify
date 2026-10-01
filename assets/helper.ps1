#requires -Version 5.1
<#
  dsh-notify —— WPF 置顶卡片助手

  常驻进程，用换行分隔 JSON 与宿主通信（走宿主 subprocess 的 control 双工管道；
  独立测试时就是 stdin/stdout）。

  协议
    宿主 → 助手  {"op":"show","id":"…","title":"…","session":"…","detail":"…"}
                 {"op":"hide"} | {"op":"quit"}
    助手 → 宿主  {"ev":"ready"} | {"ev":"activate","id":"…"} | {"ev":"close","id":"…"} | {"ev":"bye"}

  几何常量取自参考工程 src/main/toast.ts 与 resources/toast.html，单位 DIP：
    窗口 634x205
    └ stage 650x229 @ (-8,-16)          ← 故意溢出窗口，由裁剪得到阴影余量
       ├ plate 598x146 @ (26,57)        ← 唯一可交互区
       └ art   313x185 @ (304,18)       ← 右侧，头部露出卡片上沿
    ⇒ plate 落在窗口 (18,41)

  必须遵守的三条（参考工程用真金白银换来的）：
    1. 绝不调用 Activate() —— 会抢走用户正在打字的焦点
    2. 绝不 Hide() 再 Show() —— Windows 上会永久破坏鼠标投递（此后所有 API 仍报成功）
       所以窗口创建后一直 mapped，只切换内部内容的不透明度
    3. 命中测试只能靠定时器轮询 —— 点击穿透状态下收不到鼠标移动事件

  自测：
    powershell -NoProfile -STA -ExecutionPolicy Bypass -File helper.ps1 -Test
#>
[CmdletBinding()]
param(
  [string]$Art = '',
  [string]$Avatar = '',
  [switch]$Test,
  [int]$TestMs = 8000,
  # 离屏渲染一张卡片 PNG 后退出（不弹到屏幕上）。用于与浏览器预览逐像素比对。
  [string]$Render = '',
  [int]$RenderScale = 2,
  # 渲染 / 自测用的文案。必须和浏览器那边传同一份，否则逐像素比对没有意义。
  [string]$SampleTitle = '权限授予确认',
  [string]$SampleSession = 'MyProject · Bash',
  [string]$SampleDetail = '要用「完全访问」权限',
  # 点击卡片后要拉到前台的进程（DSH 的窗口持有进程）。宿主传 process.ppid。
  [int]$TargetPid = 0
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 几何常量（DIP）
# ---------------------------------------------------------------------------
$WIN_W = 634; $WIN_H = 205
$STAGE_X = -8; $STAGE_Y = -16; $STAGE_W = 650; $STAGE_H = 229
# stage 坐标
$PLATE_X = 26; $PLATE_Y = 57; $PLATE_W = 598; $PLATE_H = 146
$ART_X = 304; $ART_Y = 18; $ART_W = 313; $ART_H = 185
# 窗口坐标下的可交互区（命中测试用）
$PLATE_WIN_X = $PLATE_X + $STAGE_X   # 18
$PLATE_WIN_Y = $PLATE_Y + $STAGE_Y   # 41

# 卡片渐变：CSS linear-gradient(100deg,#151920 0%,#1b2029 52%,#252c3b 100%)
# 把 CSS 角度换算成绝对像素起止点，才能和浏览器渲染逐像素对齐：
#   dir = (sin a, -cos a)；渐变线长 L = |W·sin a| + |H·cos a|；线居中于盒子
$a = 100 * [Math]::PI / 180
$dirX = [Math]::Sin($a); $dirY = -[Math]::Cos($a)
$lineLen = [Math]::Abs($PLATE_W * $dirX) + [Math]::Abs($PLATE_H * $dirY)
$gX1 = [Math]::Round($PLATE_W / 2 - $lineLen / 2 * $dirX, 2)
$gY1 = [Math]::Round($PLATE_H / 2 - $lineLen / 2 * $dirY, 2)
$gX2 = [Math]::Round($PLATE_W / 2 + $lineLen / 2 * $dirX, 2)
$gY2 = [Math]::Round($PLATE_H / 2 + $lineLen / 2 * $dirY, 2)

# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------
$pluginRoot = Split-Path -Parent $PSScriptRoot
$assetsDir = Join-Path $pluginRoot 'assets'
if ([string]::IsNullOrWhiteSpace($Art)) { $Art = Join-Path $assetsDir 'deepseek-keyed.png' }
if ([string]::IsNullOrWhiteSpace($Avatar)) { $Avatar = Join-Path $assetsDir 'avatar.png' }

function Write-Diag([string]$msg) {
  try { [Console]::Error.WriteLine((Get-Date).ToString('HH:mm:ss.fff') + ' ' + $msg) } catch { }
}

# ---------------------------------------------------------------------------
# 原生互操作
# ---------------------------------------------------------------------------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshNotifyNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();
    [DllImport("shcore.dll")]
    public static extern int SetProcessDpiAwareness(int value);

    // 点击卡片后把 DSH 窗口拉到前台 —— 这是「跳转到对应会话」的第一步：
    // 只能由页面自己导航，所以我们要先让页面拿到焦点，
    // 它才能在 focus 事件里把待打开的会话取走。
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);

    /** 找目标进程的主窗口：可见 + 有标题的第一个顶层窗口。 */
    public static IntPtr FindMainWindow(uint want) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid != want) return true;
            if (!IsWindowVisible(h)) return true;
            if (GetWindowTextLength(h) == 0) return true;
            found = h;
            return false;
        }, IntPtr.Zero);
        return found;
    }
}
'@

# DPI 感知必须在创建任何窗口之前设置，否则在缩放显示器上卡片会发虚
try { [DshNotifyNative]::SetProcessDpiAwareness(2) | Out-Null }   # 2 = PER_MONITOR_AWARE
catch { try { [DshNotifyNative]::SetProcessDPIAware() | Out-Null } catch { } }

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
Add-Type -AssemblyName System.Windows.Forms

$GWL_EXSTYLE = -20
$WS_EX_TRANSPARENT = 0x20
$WS_EX_TOOLWINDOW = 0x80
$WS_EX_NOACTIVATE = 0x08000000
$SWP_NOSIZE = 0x1; $SWP_NOMOVE = 0x2; $SWP_NOZORDER = 0x4; $SWP_NOACTIVATE = 0x10; $SWP_FRAMECHANGED = 0x20

# ---------------------------------------------------------------------------
# 界面
# ---------------------------------------------------------------------------
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="dsh-notify"
        Width="__WIN_W__" Height="__WIN_H__"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" ShowInTaskbar="False" Topmost="True" ShowActivated="False"
        WindowStartupLocation="Manual" UseLayoutRounding="True"
        TextOptions.TextFormattingMode="Display"
        TextOptions.TextRenderingMode="Grayscale"
        FontFamily="Microsoft YaHei UI, Segoe UI">
  <!-- RenderOptions.BitmapScalingMode=HighQuality 很关键：立绘要从 1152x2048 缩到
       313x185（3.7 倍降采样），头像从 1104 缩到 31（35 倍）。WPF 默认的低质量线性
       过滤在这种幅度下会丢像素，看起来就是"糊"。HighQuality=Fant，接近浏览器。 -->
  <Canvas x:Name="Root" Width="__WIN_W__" Height="__WIN_H__" ClipToBounds="True" Background="Transparent"
          RenderOptions.BitmapScalingMode="HighQuality">
    <Canvas x:Name="Stage" Canvas.Left="__STAGE_X__" Canvas.Top="__STAGE_Y__"
            Width="__STAGE_W__" Height="__STAGE_H__">

      <!-- 卡片底板：先画，位于立绘之下（对齐 CSS：.plate 无 z-index，.art 是 2） -->
      <Border x:Name="Plate" Canvas.Left="__PLATE_X__" Canvas.Top="__PLATE_Y__"
              Width="__PLATE_W__" Height="__PLATE_H__" CornerRadius="18">
        <Border.Background>
          <LinearGradientBrush MappingMode="Absolute"
                               StartPoint="__GX1__,__GY1__" EndPoint="__GX2__,__GY2__">
            <GradientStop Color="#FF151920" Offset="0"/>
            <GradientStop Color="#FF1B2029" Offset="0.52"/>
            <GradientStop Color="#FF252C3B" Offset="1"/>
          </LinearGradientBrush>
        </Border.Background>
        <Border.BorderBrush>
          <SolidColorBrush Color="#57FFFFFF"/>
        </Border.BorderBrush>
        <Border.BorderThickness>1.5</Border.BorderThickness>
        <Border.Effect>
          <DropShadowEffect Color="#000000" BlurRadius="14" ShadowDepth="5"
                            Direction="270" Opacity="0.55"/>
        </Border.Effect>
      </Border>

      <!-- 立绘：两层嵌套不透明度遮罩（横向淡出 x 纵向淡出），对齐 CSS 的两层 mask。
           IsHitTestVisible=False 对齐 CSS 的 pointer-events:none —— 否则立绘会吃掉点击。 -->
      <Grid x:Name="ArtBox" Canvas.Left="__ART_X__" Canvas.Top="__ART_Y__"
            Width="__ART_W__" Height="__ART_H__" IsHitTestVisible="False">
        <Grid.OpacityMask>
          <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
            <GradientStop Color="#FF000000" Offset="0"/>
            <GradientStop Color="#FF000000" Offset="0.78"/>
            <GradientStop Color="#B8000000" Offset="0.92"/>
            <GradientStop Color="#4D000000" Offset="1"/>
          </LinearGradientBrush>
        </Grid.OpacityMask>
        <Grid>
          <Grid.OpacityMask>
            <LinearGradientBrush StartPoint="0,0" EndPoint="1,0">
              <GradientStop Color="#00000000" Offset="0"/>
              <GradientStop Color="#40000000" Offset="0.12"/>
              <GradientStop Color="#BF000000" Offset="0.26"/>
              <GradientStop Color="#FF000000" Offset="0.40"/>
            </LinearGradientBrush>
          </Grid.OpacityMask>
          <Rectangle x:Name="ArtRect" Width="__ART_W__" Height="__ART_H__">
            <Rectangle.Fill>
              <!-- UniformToFill + AlignmentY=0 ↔ CSS 的 cover + object-position:50% 0% -->
              <ImageBrush Stretch="UniformToFill" AlignmentX="Center" AlignmentY="Top"/>
            </Rectangle.Fill>
          </Rectangle>
        </Grid>
      </Grid>

      <!-- 文字内容：在立绘之上（对齐 CSS 的 z-index 3）。
           顶对齐，坐标与参考工程几何常量绑定。（曾改为运行时按实测高度垂直居中，已撤销。）
           IsHitTestVisible=False 对齐 CSS 的 pointer-events:none —— 否则文字区会吃掉点击。 -->
      <Grid x:Name="Content" Canvas.Left="70" Canvas.Top="75" Width="325" IsHitTestVisible="False">
        <StackPanel>
          <StackPanel Orientation="Horizontal">
            <!-- 头像用 Border.Background 承载：Border 自己的背景会被 CornerRadius 裁掉，
                 而 Border 的子元素不会 —— 这是最容易画错的一处 -->
            <Border x:Name="AvatarBox" Width="31" Height="31" CornerRadius="8"
                    BorderBrush="#22FFFFFF" BorderThickness="1.3">
              <Border.Background>
                <ImageBrush x:Name="AvatarBrush" Stretch="UniformToFill"/>
              </Border.Background>
            </Border>
            <TextBlock x:Name="TitleText" Margin="10,0,0,0" FontSize="18" FontWeight="Bold"
                       Foreground="#FFFFFFFF" VerticalAlignment="Center"
                       TextTrimming="CharacterEllipsis"/>
          </StackPanel>
          <TextBlock x:Name="SessionText" FontSize="15" Foreground="#FF8D97A7"
                     Margin="0,12,0,0" TextTrimming="CharacterEllipsis"/>
          <TextBlock x:Name="DetailText" FontSize="16" Foreground="#FFCCD4E0"
                     Margin="0,4,0,0" TextWrapping="Wrap" LineHeight="22.4"
                     LineStackingStrategy="BlockLineHeight" MaxHeight="44.8"
                     TextTrimming="CharacterEllipsis"/>
        </StackPanel>
      </Grid>

      <!-- 关闭按钮：最上层（对齐 CSS 的 z-index 4） -->
      <Border x:Name="CloseBtn" Canvas.Left="585" Canvas.Top="67" Width="26" Height="26"
              CornerRadius="7" Background="Transparent">
        <TextBlock Text="&#215;" FontSize="19" Foreground="#FF818A98"
                   HorizontalAlignment="Center" VerticalAlignment="Center"/>
      </Border>

    </Canvas>
  </Canvas>
</Window>
'@

$repl = @{
  '__WIN_W__' = $WIN_W; '__WIN_H__' = $WIN_H
  '__STAGE_X__' = $STAGE_X; '__STAGE_Y__' = $STAGE_Y
  '__STAGE_W__' = $STAGE_W; '__STAGE_H__' = $STAGE_H
  '__PLATE_X__' = $PLATE_X; '__PLATE_Y__' = $PLATE_Y
  '__PLATE_W__' = $PLATE_W; '__PLATE_H__' = $PLATE_H
  '__ART_X__' = $ART_X; '__ART_Y__' = $ART_Y
  '__ART_W__' = $ART_W; '__ART_H__' = $ART_H
  '__GX1__' = $gX1; '__GY1__' = $gY1; '__GX2__' = $gX2; '__GY2__' = $gY2
}
foreach ($k in $repl.Keys) { $xaml = $xaml.Replace($k, [string]$repl[$k]) }

$window = [System.Windows.Markup.XamlReader]::Parse($xaml)

function Load-Bitmap([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) { return $null }
  $bmp = [System.Windows.Media.Imaging.BitmapImage]::new()
  $bmp.BeginInit()
  $bmp.UriSource = [System.Uri]::new([System.IO.Path]::GetFullPath($path))
  $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
  $bmp.EndInit()
  return $bmp
}

$artBmp = Load-Bitmap $Art
if ($null -ne $artBmp) { $window.FindName('ArtRect').Fill.ImageSource = $artBmp }
else { Write-Diag "warn: 立绘缺失 $Art" }

$avatarBmp = Load-Bitmap $Avatar
if ($null -ne $avatarBmp) { $window.FindName('AvatarBrush').ImageSource = $avatarBmp }
else { Write-Diag "warn: 头像缺失 $Avatar" }

# ---------------------------------------------------------------------------
# 协议输出：显式 UTF-8，绕开控制台代码页（中文一定会踩）
# ---------------------------------------------------------------------------
$stdout = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), [System.Text.UTF8Encoding]::new($false))
$stdout.AutoFlush = $true

function Send([hashtable]$payload) {
  try { $stdout.WriteLine(($payload | ConvertTo-Json -Compress -Depth 5)) } catch { Write-Diag "send failed: $_" }
}

# ---------------------------------------------------------------------------
# 窗口定位 / 扩展样式 / 命中测试
# ---------------------------------------------------------------------------
$script:interactive = $false
$script:shown = $false
$script:currentId = ''
$script:quit = $false

function Get-Scale {
  try {
    $src = [System.Windows.PresentationSource]::FromVisual($window)
    if ($null -ne $src) { return $src.CompositionTarget.TransformToDevice.M11 }
  } catch { }
  return 1.0
}

function Place-Window {
  try {
    $cursor = [System.Windows.Forms.Cursor]::Position
    $wa = [System.Windows.Forms.Screen]::FromPoint($cursor).WorkingArea
    $scale = Get-Scale
    # 位置用「卡片边缘」表达：卡片右下角贴工作区右下角
    $cardRight = $wa.X + $wa.Width
    $cardBottom = $wa.Y + $wa.Height
    $window.Left = ($cardRight - ($PLATE_WIN_X + $PLATE_W) * $scale) / $scale
    $window.Top = ($cardBottom - ($PLATE_WIN_Y + $PLATE_H) * $scale) / $scale
  } catch { Write-Diag "place: $_" }
}

function Set-Interactive([bool]$next) {
  if ($next -eq $script:interactive) { return }
  $script:interactive = $next
  try {
    $hwnd = ([System.Windows.Interop.WindowInteropHelper]::new($window)).Handle
    if ($hwnd -eq [IntPtr]::Zero) { return }
    $ex = [DshNotifyNative]::GetWindowLong($hwnd, $GWL_EXSTYLE)
    if ($next) { $ex = $ex -band (-bnot $WS_EX_TRANSPARENT) }
    else { $ex = $ex -bor $WS_EX_TRANSPARENT }
    [DshNotifyNative]::SetWindowLong($hwnd, $GWL_EXSTYLE, $ex) | Out-Null
    # SWP_NOZORDER 很关键：绝不改 z 序，否则会掉出 topmost 带
    [DshNotifyNative]::SetWindowPos($hwnd, [IntPtr]::Zero, 0, 0, 0, 0,
      ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED)) | Out-Null
  } catch { Write-Diag "interactive: $_" }
}

function Update-HitTest {
  # 卡片隐藏时必须保持穿透，否则那块看不见的区域会吃掉底下窗口的点击
  if (-not $script:shown) { Set-Interactive $false; return }
  try {
    $cursor = [System.Windows.Forms.Cursor]::Position
    $scale = Get-Scale
    $pt = $window.PointToScreen([System.Windows.Point]::new($PLATE_WIN_X, $PLATE_WIN_Y))
    $over = ($cursor.X -ge $pt.X -and $cursor.X -le ($pt.X + $PLATE_W * $scale) -and
             $cursor.Y -ge $pt.Y -and $cursor.Y -le ($pt.Y + $PLATE_H * $scale))
    Set-Interactive $over
  } catch { }
}

function Set-CardVisible([bool]$on) {
  $op = 0.0; if ($on) { $op = 1.0 }
  foreach ($n in 'Plate', 'ArtBox', 'Content', 'CloseBtn') { $window.FindName($n).Opacity = $op }
}

function Show-Card($title, $session, $detail) {
  $window.FindName('TitleText').Text = [string]$title
  $window.FindName('SessionText').Text = [string]$session
  $window.FindName('DetailText').Text = [string]$detail
  # session 为空时整行收起、detail 补位（对齐 CSS 的 .l1:empty 折叠）
  if ([string]::IsNullOrEmpty([string]$session)) {
    $window.FindName('SessionText').Visibility = 'Collapsed'
    $window.FindName('DetailText').Margin = [System.Windows.Thickness]::new(0, 12, 0, 0)
  } else {
    $window.FindName('SessionText').Visibility = 'Visible'
    $window.FindName('DetailText').Margin = [System.Windows.Thickness]::new(0, 4, 0, 0)
  }
  Place-Window
  $script:shown = $true
  Set-CardVisible $true
}

function Hide-Card {
  # 只隐藏内容，窗口保持 mapped —— 见文件头第 2 条
  $script:shown = $false
  Set-CardVisible $false
  Set-Interactive $false
}

<#
  把 DSH 窗口拉到前台。

  为什么需要它：卡片是原生窗口，而「跳到对应会话」只能由页面自己导航。
  我们没法直接驱动 SPA，所以先让页面拿到焦点 —— 页面的 focus 处理器会去取
  「待打开的会话」并调用 openSession()。这样做也绕开了隐藏窗口里定时器被节流的问题：
  触发源是焦点事件，不是轮询。

  SetForegroundWindow 有调用权限限制，但此刻用户刚点了我们的卡片，
  本进程持有最近一次输入事件，所以是被允许的。
#>
function Focus-Target {
  if ($TargetPid -le 0) { Write-Diag 'focus: 未指定 TargetPid，跳过'; return }
  try {
    $hwnd = [DshNotifyNative]::FindMainWindow([uint32]$TargetPid)
    if ($hwnd -eq [IntPtr]::Zero) { Write-Diag "focus: 找不到目标窗口 (pid=$TargetPid)"; return }
    # 最小化时先还原，否则 SetForegroundWindow 不会把它显示出来
    if ([DshNotifyNative]::IsIconic($hwnd)) { [DshNotifyNative]::ShowWindow($hwnd, 9) | Out-Null }  # 9 = SW_RESTORE
    $ok = [DshNotifyNative]::SetForegroundWindow($hwnd)
    Write-Diag ("focus: pid={0} hwnd=0x{1:X} ok={2}" -f $TargetPid, $hwnd.ToInt64(), $ok)
  } catch {
    Write-Diag "focus failed: $_"
  }
}

# ---------------------------------------------------------------------------
# 交互
#
# ⚠️ 点击处理器挂在 **Root** 上，不是挂在 Plate 上。
#     原因：文字区（Content）与立绘（ArtBox）在视觉上盖在卡片之上，而它们是卡片的
#     **兄弟节点**。事件冒泡只沿祖先链走 —— 点在文字或立绘上时，事件根本不会经过
#     Plate，挂在 Plate 上的处理器永远不触发。实测就是这样：日志里一条 activate 都没有。
#     挂在 Root 上之后，任何落在卡片区域的点击都必然经过它。
#     （同时给 Content / ArtBox 补了 IsHitTestVisible=False，对齐 CSS 的 pointer-events:none。）
# ---------------------------------------------------------------------------
$window.FindName('CloseBtn').Add_MouseLeftButtonUp({
  param($sender, $e)
  # 必须标记已处理，否则会继续冒泡到 Root 而同时触发 activate
  if ($null -ne $e) { $e.Handled = $true }
  Send @{ ev = 'close'; id = $script:currentId }
  Hide-Card
})
$window.FindName('Root').Add_MouseLeftButtonUp({
  Send @{ ev = 'activate'; id = $script:currentId }
  Hide-Card
  # 拉起 DSH 窗口：页面拿到焦点后会在 focus 事件里取走待打开的会话并导航
  Focus-Target
})

$window.Add_SourceInitialized({
  try {
    $hwnd = ([System.Windows.Interop.WindowInteropHelper]::new($window)).Handle
    $ex = [DshNotifyNative]::GetWindowLong($hwnd, $GWL_EXSTYLE)
    # NOACTIVATE：点击不激活（不抢焦点）；TOOLWINDOW：不进 Alt-Tab；TRANSPARENT：初始穿透
    $ex = $ex -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW -bor $WS_EX_TRANSPARENT
    [DshNotifyNative]::SetWindowLong($hwnd, $GWL_EXSTYLE, $ex) | Out-Null
    $script:interactive = $false
    # 在窗口出现之前定位，避免先出现在默认位置再跳
    Place-Window
  } catch { Write-Diag "SourceInitialized: $_" }
})

# 命中测试轮询：穿透状态下收不到鼠标移动事件，只能轮询
$hitTimer = [System.Windows.Threading.DispatcherTimer]::new()
$hitTimer.Interval = [TimeSpan]::FromMilliseconds(50)
$hitTimer.Add_Tick({ Update-HitTest })
$hitTimer.Start()

# ---------------------------------------------------------------------------
# stdin 协议循环
#
# ⚠️ 绝不能用 [Console]::In.ReadLine() —— 它阻塞 UI 线程，窗口直接卡死。
# 改为 ReadLineAsync() + DispatcherTimer 轮询，让 UI 线程始终在泵消息。
# ---------------------------------------------------------------------------
$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))
$script:readTask = $null

function Start-Read {
  try { $script:readTask = $stdin.ReadLineAsync() } catch { $script:readTask = $null }
}

function Handle-Line([string]$line) {
  if ([string]::IsNullOrWhiteSpace($line)) { return }
  $msg = $null
  try { $msg = $line | ConvertFrom-Json } catch { Write-Diag "bad json: $line"; return }
  switch ([string]$msg.op) {
    'show' {
      $script:currentId = [string]$msg.id
      Show-Card $msg.title $msg.session $msg.detail
    }
    'hide' { Hide-Card }
    'quit' { $script:quit = $true }
    default { Write-Diag "unknown op: $($msg.op)" }
  }
}

$readTimer = [System.Windows.Threading.DispatcherTimer]::new()
$readTimer.Interval = [TimeSpan]::FromMilliseconds(30)
$readTimer.Add_Tick({
  if ($script:quit) { $readTimer.Stop(); $window.Close(); return }
  $t = $script:readTask
  if ($null -eq $t) { Start-Read; return }
  if (-not $t.IsCompleted) { return }
  $line = $null
  try { $line = $t.Result } catch { $line = $null }
  if ($null -eq $line) {
    # 宿主关掉了 stdin ⇒ 退出
    $script:quit = $true
    $readTimer.Stop()
    $window.Close()
    return
  }
  Handle-Line $line
  Start-Read
})

# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------
# 渲染模式的定时器**必须建在脚本作用域**。
# 教训：在 Add_Loaded 处理器里建的局部变量，等处理器返回后再在 tick 回调里引用，
# 会解析为 $null（PowerShell 脚本块捕获的是作用域，不是闭包值）——
# 表现就是 tick 里一句 `$renderTimer.Stop()` 抛"不能对 Null 值表达式调用方法"。
$renderTimer = [System.Windows.Threading.DispatcherTimer]::new()
$renderTimer.Interval = [TimeSpan]::FromMilliseconds(500)
$renderTimer.Add_Tick({
  $renderTimer.Stop()
  try {
    $px = [int]($WIN_W * $RenderScale)
    $py = [int]($WIN_H * $RenderScale)
    $rtb = [System.Windows.Media.Imaging.RenderTargetBitmap]::new(
      $px, $py, 96 * $RenderScale, 96 * $RenderScale,
      [System.Windows.Media.PixelFormats]::Pbgra32)
    $rtb.Render($window.FindName('Root'))
    $enc = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
    $enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($rtb))
    $fs = [System.IO.File]::Create($Render)
    $enc.Save($fs)
    $fs.Close()
    Send @{ ev = 'rendered'; path = $Render; w = $px; h = $py }
  } catch {
    Send @{ ev = 'render-error'; message = [string]$_; stack = [string]$_.ScriptStackTrace }
  }
  $window.Close()
})

$window.Add_Loaded({
  Hide-Card
  Send @{ ev = 'ready'; pid = $PID }
  if ($Test) {
    $script:currentId = 'test'
    Show-Card $SampleTitle $SampleSession $SampleDetail
  }
  if (-not [string]::IsNullOrWhiteSpace($Render)) {
    # 渲染模式：把窗口挪到屏幕外（透明 + 穿透，用户看不到），排好版后离屏出图
    $window.Left = -20000
    $window.Top = -20000
    Show-Card $SampleTitle $SampleSession $SampleDetail
    $renderTimer.Start()
  }
})

$window.Add_Closed({
  Send @{ ev = 'bye' }
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
})

if ($Render -ne '' -or $Test) {
  # 渲染 / 自测模式下 stdio 常是关的，一旦读循环启动会立刻收到 null 而自关
  if ($Test) {
    $testTimer = [System.Windows.Threading.DispatcherTimer]::new()
    $testTimer.Interval = [TimeSpan]::FromMilliseconds($TestMs)
    $testTimer.Add_Tick({
      $testTimer.Stop()
      Send @{ ev = 'test-done' }
      $window.Close()
    })
    $testTimer.Start()
  }
} else {
  Start-Read
  $readTimer.Start()
}

Write-Diag "helper started pid=$PID art=$Art"
try {
  $window.Show()
  [System.Windows.Threading.Dispatcher]::Run()
} catch {
  Write-Diag "fatal: $_"
  Send @{
    ev = 'error'
    message = [string]$_
    inner = [string]$_.Exception.InnerException
    stack = [string]$_.ScriptStackTrace
  }
  exit 1
}
Write-Diag 'helper stopped'
