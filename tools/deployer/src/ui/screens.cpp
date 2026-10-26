// 五个页面的完整 Apple 风格布局：欢迎 / 配置 / 安装 / 结果 / 关于。
#include "ui/screens.h"

#include "app.h"
#include "core/core.h"
#include "platform/platform.h"
#include "ui/theme.h"
#include "ui/widgets.h"

#include "imgui.h"
#include "imgui_internal.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <string>
#include <vector>

namespace mes::ui {
namespace {

using mes::AppState;
using mes::LogLine;
using mes::Screen;

// ---------------------------------------------------------------- 基础工具
float sp(float value) { return value * theme().scale; }
ImDrawList* dl() { return ImGui::GetWindowDrawList(); }
ImVec2 displaySize() { return ImGui::GetIO().DisplaySize; }
float contentX() { return theme().margin; }
float contentWidth() { return displaySize().x - 2.0f * theme().margin; }
float contentTop() { return theme().topBarHeight + sp(24.0f); }
float contentBottom() { return displaySize().y - theme().footerHeight; }
void setCursor(float x, float y) { ImGui::SetCursorScreenPos(ImVec2(x, y)); }

ImFont* fSmall() {
  Theme& t = theme();
  return t.fontSmall ? t.fontSmall : (t.fontBody ? t.fontBody : ImGui::GetFont());
}
ImFont* fBody() {
  Theme& t = theme();
  return t.fontBody ? t.fontBody : ImGui::GetFont();
}
ImFont* fMedium() {
  Theme& t = theme();
  return t.fontMedium ? t.fontMedium : fBody();
}
ImFont* fTitle() {
  Theme& t = theme();
  return t.fontTitle ? t.fontTitle : fMedium();
}
ImFont* fHero() {
  Theme& t = theme();
  return t.fontHero ? t.fontHero : fTitle();
}

ImVec2 measure(ImFont* font, const std::string& text) {
  return measureText(font, text.c_str());
}
void label(ImFont* font, const ImVec2& pos, ImU32 color, const std::string& text) {
  drawLabel(dl(), font, pos, color, text.c_str());
}
void labelCenter(ImFont* font, const Rect& rect, ImU32 color,
                 const std::string& text) {
  drawLabelCenter(dl(), font, rect.min, rect.max, color, text.c_str());
}
void labelWrapped(ImFont* font, const ImVec2& pos, ImU32 color,
                  const std::string& text, float wrap) {
  drawLabelWrapped(dl(), font, pos, color, text.c_str(), wrap);
}

// 让整个 ImGui 窗口变成无边框、铺满屏幕的画布（main 的窗口按钮仍可用）。
void prepareRootWindow() {
  ImGuiIO& io = ImGui::GetIO();
  ImGuiWindow* window = ImGui::GetCurrentWindow();
  if (window) {
    window->Flags |= ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoBackground |
                     ImGuiWindowFlags_NoScrollbar |
                     ImGuiWindowFlags_NoScrollWithMouse |
                     ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoResize |
                     ImGuiWindowFlags_NoCollapse |
                     ImGuiWindowFlags_NoSavedSettings |
                     ImGuiWindowFlags_NoBringToFrontOnFocus;
    window->TitleBarHeight = 0.0f;
    window->MenuBarHeight = 0.0f;
    ImGui::SetWindowPos(window, ImVec2(0, 0), ImGuiCond_Always);
    ImGui::SetWindowSize(window, io.DisplaySize, ImGuiCond_Always);
    const ImRect full(ImVec2(0, 0), io.DisplaySize);
    window->InnerRect = full;
    window->InnerClipRect = full;
    window->ClipRect = full;
    window->Scroll = ImVec2(0, 0);
  }
  dl()->PushClipRect(ImVec2(0, 0), io.DisplaySize, false);
  ImGui::SetCursorScreenPos(ImVec2(0, 0));
}

bool pageBlocked(const AppState& state) {
  return mes::modalOpen(state) || state.screen == Screen::About;
}

void openAbout(AppState& state) {
  if (state.screen != Screen::About) state.previousScreen = state.screen;
  state.aboutScroll = 0.0f;
  state.screen = Screen::About;
}

void closeAbout(AppState& state) {
  state.screen = (state.previousScreen == Screen::About) ? Screen::Welcome
                                                         : state.previousScreen;
}

std::string clockText() {
  const std::time_t now = std::time(nullptr);
  std::tm local{};
#if defined(_WIN32)
  localtime_s(&local, &now);
#else
  localtime_r(&now, &local);
#endif
  char buffer[16] = {0};
  std::strftime(buffer, sizeof(buffer), "%H:%M:%S", &local);
  return buffer;
}

std::string percentText(int percent) {
  return std::to_string(std::max(0, std::min(100, percent))) + "%";
}

std::string stateLabel(const AppState& state) {
  if (state.screen == Screen::About) return "关于";
  if (state.busy) return "正在部署 · " + percentText(state.uiProgress.percent);
  if (state.screen == Screen::Installing) return "部署预览";
  if (state.screen == Screen::Result) {
    if (state.uiResult.cancelled) return "已取消";
    return state.uiResult.ok ? "部署完成" : "需要处理";
  }
  return "空闲";
}

ImU32 levelColor(const std::string& level) {
  const Palette& c = theme().colors;
  if (level == "error" || level == "fail") return c.danger;
  if (level == "warn" || level == "warning") return c.warning;
  if (level == "ok" || level == "success") return c.success;
  if (level == "step") return c.accent;
  return c.textSecondary;
}

std::string levelTag(const std::string& level) {
  if (level == "error" || level == "fail") return "错误";
  if (level == "warn" || level == "warning") return "提示";
  if (level == "ok" || level == "success") return "完成";
  if (level == "step") return "步骤";
  return "日志";
}

// ---------------------------------------------------------------- 通用组件
// Windows 下把 platform::joinPath 产生的混合分隔符统一显示为反斜杠。
std::string prettyPath(const std::string& path) {
  if (platform::platformName() != "windows") return path;
  std::string out = path;
  for (char& ch : out) {
    if (ch == '/') ch = '\\';
  }
  return out;
}

void pageHeader(const std::string& title, const std::string& subtitle) {
  const float x = contentX();
  const float y = contentTop();
  label(fTitle(), ImVec2(x, y), theme().colors.text, title);
  if (!subtitle.empty()) {
    label(fBody(), ImVec2(x, y + textSize(fTitle()) + sp(6.0f)),
          theme().colors.textSecondary, subtitle);
  }
}

void drawStepper(int active, float rightX, float centerY) {
  const Theme& t = theme();
  const Palette& c = t.colors;
  ImDrawList* draw = dl();
  static const char* labels[] = {"欢迎", "配置", "安装", "完成"};
  const float gap = sp(10.0f);
  const float circleR = sp(11.0f);
  std::vector<float> widths;
  float total = 0.0f;
  for (int i = 0; i < 4; ++i) {
    const float textW = measure(fSmall(), labels[i]).x;
    widths.push_back(circleR * 2.0f + sp(6.0f) + textW);
    total += widths.back();
    if (i < 3) total += sp(18.0f) + gap;
  }
  float x = rightX - total;
  for (int i = 0; i < 4; ++i) {
    const ImVec2 center(x + circleR, centerY);
    const bool done = i < active;
    const bool current = i == active;
    if (done) {
      draw->AddCircleFilled(center, circleR, withAlpha(c.success, 0.16f), 24);
      paint::checkmark(draw, center, circleR * 1.1f, c.success, sp(1.8f));
    } else if (current) {
      draw->AddCircleFilled(center, circleR, c.accent, 24);
      const std::string number = std::to_string(i + 1);
      labelCenter(fSmall(), Rect{ImVec2(center.x - circleR, center.y - circleR),
                                 ImVec2(center.x + circleR, center.y + circleR)},
                  c.textInverse, number);
    } else {
      draw->AddCircle(center, circleR, withAlpha(c.textTertiary, 0.45f), 24,
                      sp(1.2f));
      const std::string number = std::to_string(i + 1);
      labelCenter(fSmall(), Rect{ImVec2(center.x - circleR, center.y - circleR),
                                 ImVec2(center.x + circleR, center.y + circleR)},
                  c.textTertiary, number);
    }
    label(fSmall(), ImVec2(x + circleR * 2.0f + sp(6.0f),
                           centerY - textSize(fSmall()) * 0.5f),
          current ? c.text : (done ? c.textSecondary : c.textTertiary), labels[i]);
    x += widths[i] + sp(18.0f) + gap;
  }
}

void drawDshBadge(float x, float y) {
  ImDrawList* draw = dl();
  const std::string text = "powered by DSH";
  const float textW = measure(fSmall(), text).x;
  const float h = sp(26.0f);
  const float w = textW + sp(46.0f);
  const Rect rect{ImVec2(x, y), ImVec2(x + w, y + h)};
  draw->AddRectFilled(rect.min, rect.max, IM_COL32(28, 30, 36, 236), h * 0.5f);
  draw->AddRect(rect.min, rect.max, IM_COL32(255, 255, 255, 40), h * 0.5f, 0,
                sp(0.8f));
  const ImVec2 mark(rect.min.x + sp(15.0f), rect.center().y);
  draw->AddCircleFilled(mark, sp(8.0f), IM_COL32(94, 130, 255, 255), 24);
  draw->AddCircleFilled(ImVec2(mark.x - sp(2.5f), mark.y - sp(2.0f)), sp(4.6f),
                        IM_COL32(160, 200, 255, 190), 20);
  label(fSmall(), ImVec2(mark.x + sp(12.0f),
                         rect.center().y - textSize(fSmall()) * 0.5f),
        IM_COL32(240, 244, 255, 235), text);
}

// ---------------------------------------------------------------- 欢迎页
void drawInstalledStrip(AppState& state, const Rect& rect) {
  const Theme& t = theme();
  const Palette& c = t.colors;
  ImDrawList* draw = dl();
  paint::glassPanel(draw, rect.min, rect.max, sp(18.0f), false);
  const float padX = sp(22.0f);
  const float cy = rect.center().y;
  setCursor(rect.min.x + padX, cy - sp(6.0f));
  statusDot(state.serviceRunning ? c.success : c.textTertiary, sp(5.0f));
  const float dotEnd = ImGui::GetCursorScreenPos().x;
  label(fMedium(), ImVec2(dotEnd, cy - sp(19.0f)), c.text,
        state.serviceRunning ? "已安装 · 运行中" : "已安装 · 已停止");
  const float versionW = measure(fSmall(), core::kVersion).x + sp(20.0f);
  setCursor(dotEnd + measure(fMedium(), "已安装 · 运行中").x + sp(12.0f),
            cy - sp(20.0f));
  badge(state.installed ? state.installState.version.c_str() : core::kVersion,
        withAlpha(c.accent, 0.12f), c.accent);
  (void)versionW;
  if (state.previewData) {
    badge("演示数据", withAlpha(c.warning, 0.14f), c.warning);
  }
  std::string dir = state.installState.installDir;
  if (dir.empty()) dir = state.options.installDir;
  dir = prettyPath(dir);
  label(fSmall(), ImVec2(dotEnd, cy + sp(9.0f)), c.textTertiary,
        "安装目录：" + elideText(dir, rect.size().x - sp(320.0f), fSmall()));

  // 右侧快捷操作
  const float buttonH = sp(34.0f);
  const float buttonY = cy - buttonH * 0.5f;
  const float gap = sp(8.0f);
  const float uninstallW = sp(84.0f);
  const float stopW = sp(104.0f);
  const float openW = sp(112.0f);
  float x = rect.max.x - padX - uninstallW;
  setCursor(x, buttonY);
  if (actionButton("welcome-uninstall", Icon::Trash, "卸载",
                   ImVec2(uninstallW, buttonH), false, true)) {
    state.confirmUninstall = true;
  }
  x -= gap + stopW;
  setCursor(x, buttonY);
  if (actionButton("welcome-stop", Icon::Stop,
                   state.serviceRunning ? "停止服务" : "停止服务",
                   ImVec2(stopW, buttonH), false, false)) {
    if (state.serviceRunning) {
      mes::startStop(state);
    } else {
      mes::notify(state, "服务当前未运行", false);
    }
  }
  x -= gap + openW;
  setCursor(x, buttonY);
  if (actionButton("welcome-open", Icon::Play, "打开应用",
                   ImVec2(openW, buttonH), true, false)) {
    mes::startOpenApp(state);
  }
}

void drawWelcomePage(AppState& state) {
  const Theme& t = theme();
  const Palette& c = t.colors;
  const float x = contentX();
  const float w = contentWidth();
  float y = contentTop();

  // 品牌区
  iconBadge(dl(), ImVec2(x + sp(26.0f), y + sp(26.0f)), sp(26.0f),
            Icon::Sparkle, c.accentLight, c.accentDeep, 0.5f);
  label(fHero(), ImVec2(x + sp(68.0f), y - sp(4.0f)), c.text,
        "校园作业分析");
  label(fBody(), ImVec2(x + sp(70.0f), y + sp(44.0f)), c.textSecondary,
        "桌面部署器 · 一键在本机或服务器上完成安装");
  // 右侧版本标签
  {
    const float badgeY = y + sp(14.0f);
    const std::string items[] = {
        state.platform.osLabel + " · " + state.platform.archLabel,
        "离线安装 · 无需 Node.js",
    };
    float totalW = 0.0f;
    for (const std::string& item : items) {
      totalW += measure(fSmall(), item).x + sp(20.0f) + sp(8.0f);
    }
    float bx = x + w - totalW + sp(8.0f);
    for (int i = 0; i < 2; ++i) {
      setCursor(bx, badgeY);
      const ImU32 bg = i == 0 ? withAlpha(c.accent, 0.12f)
                              : withAlpha(IM_COL32(255, 255, 255, 255), 0.55f);
      const ImU32 fg = i == 0 ? c.accent : c.textSecondary;
      badge(items[i].c_str(), bg, fg);
      bx += measure(fSmall(), items[i]).x + sp(20.0f) + sp(8.0f);
    }
  }

  // 选择部署方式
  const float sectionY = y + sp(92.0f);
  label(fMedium(), ImVec2(x, sectionY), c.text, "选择部署方式");
  {
    const std::string hintText = "安装位置与端口可在下一步调整";
    const float hintW = measure(fSmall(), hintText).x;
    label(fSmall(), ImVec2(x + w - hintW, sectionY + sp(3.0f)), c.textTertiary,
          hintText);
  }

  const float cardsY = sectionY + sp(34.0f);
  const float gap = sp(20.0f);
  const float cardW = (w - gap) * 0.5f;
  const float cardH = state.installed ? sp(236.0f) : sp(292.0f);

  setCursor(x, cardsY);
  setLayoutWidth(cardW);
  if (selectCard("welcome-local", "本地版",
                 "在这台电脑上直接使用 · Local",
                 "数据保存在本机，只监听 127.0.0.1\n安装完成后自动打开浏览器\n无需服务器与域名，卸载即净\n安装到用户目录，无需管理员权限",
                 state.edition == core::Edition::Local, cardH, "local")) {
    state.edition = core::Edition::Local;
    state.options.edition = core::Edition::Local;
    state.options.installDir = mes::normalizePath(core::defaultInstallDir(core::Edition::Local));
  }
  setCursor(x + cardW + gap, cardsY);
  setLayoutWidth(cardW);
  if (selectCard("welcome-server", "服务器版",
                 "部署为局域网 / 公网可访问的服务 · Server",
                 "监听局域网，同学与老师可同时访问\n支持开机自启、防火墙与生产模式\n数据目录可独立备份与迁移\n安装后可用局域网 IP 访问",
                 state.edition == core::Edition::Server, cardH, "server")) {
    state.edition = core::Edition::Server;
    state.options.edition = core::Edition::Server;
    state.options.installDir = mes::normalizePath(core::defaultInstallDir(core::Edition::Server));
  }

  float belowCards = cardsY + cardH;
  if (state.installed) {
    const Rect strip{ImVec2(x, belowCards + sp(18.0f)),
                     ImVec2(x + w, belowCards + sp(18.0f) + sp(92.0f))};
    drawInstalledStrip(state, strip);
    belowCards = strip.max.y;
  } else {
    // 三个小卖点
    static const struct {
      Icon icon;
      const char* title;
      const char* desc;
    } features[] = {
        {Icon::Download, "离线安装包", "内置校验，断网也能部署"},
        {Icon::Shield, "自动生成密钥", "APP_SECRET 写入 .env"},
        {Icon::Refresh, "随时停止 / 卸载", "数据目录可保留可迁移"},
    };
    const float featureY = belowCards + sp(24.0f);
    const float featureH = sp(70.0f);
    const float featureW = (w - gap * 2.0f) / 3.0f;
    for (int i = 0; i < 3; ++i) {
      const Rect rect{ImVec2(x + (featureW + gap) * static_cast<float>(i), featureY),
                      ImVec2(x + (featureW + gap) * static_cast<float>(i) + featureW,
                             featureY + featureH)};
      paint::glassPanel(dl(), rect.min, rect.max, sp(16.0f), false);
      iconBadge(dl(), ImVec2(rect.min.x + sp(30.0f), rect.center().y), sp(17.0f),
                features[i].icon, withAlpha(c.accent, 0.55f),
                withAlpha(c.accentDeep, 0.85f), 0.48f);
      label(fMedium(), ImVec2(rect.min.x + sp(56.0f), rect.min.y + sp(15.0f)),
            c.text, features[i].title);
      label(fSmall(), ImVec2(rect.min.x + sp(56.0f), rect.min.y + sp(40.0f)),
            c.textSecondary, features[i].desc);
    }
    belowCards = featureY + featureH;
  }
  (void)belowCards;

  // 底部操作
  const float buttonY = contentBottom() - sp(20.0f) - sp(48.0f);
  const std::string editionDesc =
      state.edition == core::Edition::Local
          ? "本地版：数据只保存在这台电脑上，安装完成后自动打开浏览器。"
          : "服务器版：监听局域网，建议在服务器上以管理员权限运行。";
  label(fSmall(), ImVec2(x, buttonY + sp(4.0f)), c.textSecondary, editionDesc);
  const std::string dirHint = "默认安装位置：" +
                              prettyPath(state.options.installDir.empty()
                                             ? core::defaultInstallDir(state.edition)
                                             : state.options.installDir);
  label(fSmall(), ImVec2(x, buttonY + sp(24.0f)), c.textTertiary,
        elideText(dirHint, w - sp(360.0f), fSmall()));

  const float nextW = sp(168.0f);
  const float aboutW = sp(124.0f);
  const float gap2 = sp(12.0f);
  float bx = x + w - nextW;
  setCursor(bx, buttonY);
  if (primaryButton("下一步", ImVec2(nextW, sp(48.0f)))) {
    state.screen = Screen::Configure;
  }
  bx -= gap2 + aboutW;
  setCursor(bx, buttonY + sp(7.0f));
  if (quietButton("关于部署器", ImVec2(aboutW, sp(34.0f)))) {
    openAbout(state);
  }
}

// ---------------------------------------------------------------- 配置页
void drawConfigurePage(AppState& state) {
  const Theme& t = theme();
  const Palette& c = t.colors;
  const float x = contentX();
  const float w = contentWidth();
  pageHeader("配置部署", "选择安装方式与参数，确认后开始一键部署。");
  drawStepper(1, x + w, contentTop() + sp(14.0f));

  const float cardsY = contentTop() + sp(74.0f);
  const float bottomY = contentBottom() - sp(16.0f) - sp(48.0f);
  const float cardH = bottomY - sp(20.0f) - cardsY;
  const float leftW = w * 0.585f;
  const float gap = sp(20.0f);
  const float rightW = w - leftW - gap;

  // ---- 左侧设置卡片
  setCursor(x, cardsY);
  Rect leftInner = card("configure-left", ImVec2(leftW, cardH), sp(20.0f), true);
  setLayoutWidth(leftInner.size().x);
  const float labelW = sp(92.0f);
  const float contentW = leftInner.size().x;
  const float fieldX = leftInner.min.x + labelW;
  const float fieldW = contentW - labelW;

  auto rowLabel = [&](float rowY, const char* text) {
    label(fSmall(), ImVec2(leftInner.min.x, rowY + sp(10.0f)), c.textTertiary,
          text);
  };

  float y = leftInner.min.y;
  // 版本
  rowLabel(y, "版本");
  {
    static const char* editionLabels[] = {"本地版", "服务器版"};
    int editionIndex = state.edition == core::Edition::Local ? 0 : 1;
    setCursor(fieldX, y + sp(4.0f));
    setLayoutWidth(fieldW);
    if (segmented("configure-edition", editionLabels, 2, &editionIndex)) {
      state.edition = editionIndex == 0 ? core::Edition::Local
                                        : core::Edition::Server;
      state.options.edition = state.edition;
      state.options.installDir = mes::normalizePath(core::defaultInstallDir(state.edition));
    }
  }
  y += sp(44.0f);

  // 安装目录
  rowLabel(y, "安装目录");
  {
    setCursor(fieldX, y);
    const float browseW = sp(118.0f);
    setLayoutWidth(fieldW);
    textField("configure-dir", &state.options.installDir, "安装目录",
              fieldW - browseW - sp(8.0f));
    setCursor(fieldX + fieldW - browseW, y);
    setLayoutWidth(browseW);
    if (quietButton("选择文件夹", ImVec2(browseW, sp(40.0f)))) {
      const std::string picked = pickFolder(state.options.installDir);
      if (!picked.empty()) {
        state.options.installDir = mes::normalizePath(picked);
        state.lastDirPicked = picked;
      }
    }
  }
  y += sp(46.0f);

  // 端口
  rowLabel(y, "端口");
  {
    setCursor(fieldX, y);
    std::string portText = std::to_string(state.options.port);
    setLayoutWidth(fieldW);
    if (textField("configure-port", &portText, "端口", sp(120.0f), true)) {
      const long parsed = std::strtol(portText.c_str(), nullptr, 10);
      if (parsed >= 1 && parsed <= 65535) state.options.port = static_cast<int>(parsed);
    }
    const std::string hintText = std::string("当前端口 ")+std::to_string(state.options.port)+" · " +
                                 std::string(state.edition == core::Edition::Local
                                                 ? "本地版仅本机可访问"
                                                 : "服务器版局域网可访问");
    label(fSmall(), ImVec2(fieldX + sp(132.0f), y + sp(12.0f)), c.textTertiary,
          hintText);
  }
  y += sp(46.0f);

  // 版本相关选项
  if (state.edition == core::Edition::Local) {
    label(fMedium(), ImVec2(leftInner.min.x, y), c.text, "完成后");
    y += sp(26.0f);
    label(fBody(), ImVec2(leftInner.min.x, y + sp(4.0f)), c.text, "完成后打开浏览器");
    setCursor(leftInner.max.x - sp(48.0f), y);
    setLayoutWidth(sp(48.0f));
    toggle("configure-openbrowser", &state.options.openBrowser);
    y += sp(32.0f);
  } else {
    label(fMedium(), ImVec2(leftInner.min.x, y), c.text, "服务器选项");
    y += sp(26.0f);
    struct ToggleRow {
      const char* label;
      bool* value;
      const char* id;
    };
    ToggleRow rows[] = {
        {"局域网访问（HOST 0.0.0.0）", &state.options.lan, "configure-lan"},
        {"开机自启（系统服务）", &state.options.autostart, "configure-autostart"},
        {"自动放行防火墙端口", &state.options.firewall, "configure-firewall"},
        {"生产模式（NODE_ENV=production）", &state.options.production,
         "configure-production"},
    };
    for (const ToggleRow& row : rows) {
      label(fBody(), ImVec2(leftInner.min.x, y + sp(3.0f)), c.text, row.label);
      setCursor(leftInner.max.x - sp(48.0f), y);
      setLayoutWidth(sp(48.0f));
      toggle(row.id, row.value);
      y += sp(29.0f);
    }
    if (state.options.production) {
      label(fSmall(), ImVec2(leftInner.min.x, y), c.warning,
            "生产模式需要自行配置 HTTPS 反向代理（Nginx / Caddy）。");
      y += sp(18.0f);
    }
  }

  // 安装包来源
  label(fMedium(), ImVec2(leftInner.min.x, y), c.text, "安装包来源");
  y += sp(24.0f);
  int sourceIndex = state.options.payloadZip.empty() ? 0 : 1;
  {
    const std::string downloadLabel=std::string("自动下载 ")+state.options.releaseTag;
    const char* sourceLabels[] = {downloadLabel.c_str(), "选择本地 zip"};
    rowLabel(y, "来源");
    setCursor(fieldX, y + sp(2.0f));
    setLayoutWidth(fieldW);
    if (segmented("configure-source", sourceLabels, 2, &sourceIndex)) {
      if (sourceIndex == 0) state.options.payloadZip.clear();
    }
  }
  y += sp(44.0f);
  if (sourceIndex == 1) {
    setCursor(fieldX, y);
    const float browseW = sp(86.0f);
    setLayoutWidth(fieldW);
    textField("configure-zip", &state.options.payloadZip, "安装包 zip 路径",
              fieldW - browseW - sp(8.0f));
    setCursor(fieldX + fieldW - browseW, y);
    setLayoutWidth(browseW);
    if (quietButton("浏览…", ImVec2(browseW, sp(40.0f)))) {
      const std::string picked = pickFile("选择安装包", {"zip"});
      if (!picked.empty()) state.options.payloadZip = picked;
    }
    y += sp(46.0f);
    label(fSmall(), ImVec2(leftInner.min.x, y), c.textTertiary,
          "离线安装：将直接解压该 zip，并校验文件完整性。");
  } else if (state.edition == core::Edition::Server) {
    setCursor(fieldX, y);
    setLayoutWidth(fieldW);
    textField("configure-url", &state.options.payloadUrl,
              "自定义下载地址（可选，留空使用 GitHub Releases）", fieldW);
    y += sp(46.0f);
  } else {
    label(fSmall(), ImVec2(leftInner.min.x, y), c.textTertiary,
          std::string("将读取 GitHub Releases 清单 ")+state.options.releaseTag+"，按真实清单大小下载并校验 SHA-256。");
  }

  // 底部安装前检查提示
  const float noteH = sp(62.0f);
  const float noteTop = leftInner.max.y - noteH;
  if (y < noteTop - sp(8.0f)) {
    const Rect note{ImVec2(leftInner.min.x, noteTop),
                    ImVec2(leftInner.max.x, noteTop + noteH)};
    dl()->AddRectFilled(note.min, note.max, withAlpha(c.accent, 0.06f),
                        sp(12.0f));
    dl()->AddRect(note.min, note.max, withAlpha(c.accent, 0.16f), sp(12.0f), 0,
                  sp(0.9f));
    paintIcon(dl(), ImVec2(note.min.x + sp(18.0f), note.min.y + sp(18.0f)),
              sp(13.0f), Icon::Info, withAlpha(c.accent, 0.85f), 1.4f);
    const std::string noteText =
        state.edition == core::Edition::Local
            ? "安装前检查：程序写入用户目录，无需管理员权限；首次安装需联网下载并校验安装包（约 43 MB）。"
            : "安装前检查：服务器版会创建系统服务并放行端口，安装时需要管理员权限；请确保端口未被占用。";
    labelWrapped(fSmall(), ImVec2(note.min.x + sp(34.0f), note.min.y + sp(11.0f)),
                 c.textSecondary, noteText, note.size().x - sp(50.0f));
  }
  // ---- 右侧摘要卡片
  setCursor(x + leftW + gap, cardsY);
  Rect rightInner = card("configure-right", ImVec2(rightW, cardH), sp(20.0f), false);
  setLayoutWidth(rightInner.size().x);
  {
    const float rx = rightInner.min.x;
    float ry = rightInner.min.y;
    label(fSmall(), ImVec2(rx, ry), c.textTertiary, "SUMMARY");
    ry += sp(18.0f);
    label(fTitle(), ImVec2(rx, ry), c.text, "部署摘要");
    ry += textSize(fTitle()) + sp(4.0f);
    label(fSmall(), ImVec2(rx, ry), c.textSecondary,
          core::editionTagline(state.edition));
    ry += sp(22.0f);
    paint::hairline(dl(), rx, rightInner.max.x, ry, 0.9f);
    ry += sp(10.0f);

    auto summaryRow = [&](const char* name, const std::string& value) {
      label(fSmall(), ImVec2(rx, ry + sp(2.0f)), c.textTertiary, name);
      label(fBody(), ImVec2(rx + sp(70.0f), ry), c.text,
            elideText(value, rightInner.size().x - sp(70.0f), fBody()));
      ry += sp(26.0f);
    };
    const std::string installDir = state.options.installDir.empty()
                                       ? core::defaultInstallDir(state.edition)
                                       : state.options.installDir;
    const std::string dataDir = core::defaultDataDir(state.options);
    summaryRow("安装位置", prettyPath(installDir));
    summaryRow("数据位置", prettyPath(dataDir));
    summaryRow("访问端口", std::to_string(state.options.port));
    summaryRow("访问地址",
               state.edition == core::Edition::Local
                   ? "http://127.0.0.1:" + std::to_string(state.options.port)
                   : "http://<本机 IP>:" + std::to_string(state.options.port));

    ry += sp(4.0f);
    paint::hairline(dl(), rx, rightInner.max.x, ry, 0.9f);
    ry += sp(12.0f);
    label(fSmall(), ImVec2(rx, ry), c.textTertiary, "将执行的步骤");
    ry += sp(20.0f);
    static const char* steps[] = {"检查系统兼容性", "获取安装包", "校验安装包",
                                  "解压应用文件", "写入配置与环境变量",
                                  "安装服务 / 启动应用", "健康检查"};
    for (int i = 0; i < 7; ++i) {
      dl()->AddCircleFilled(ImVec2(rx + sp(6.0f), ry + sp(8.0f)), sp(3.0f),
                            withAlpha(c.accent, 0.55f), 12);
      label(fSmall(), ImVec2(rx + sp(18.0f), ry), c.textSecondary, steps[i]);
      ry += sp(18.0f);
    }

    paint::hairline(dl(), rx, rightInner.max.x, ry + sp(2.0f), 0.9f);
    ry += sp(12.0f);
    label(fSmall(), ImVec2(rx, ry), c.textTertiary, "平台与支持");
    ry += sp(19.0f);
    const std::string platformLine =
        state.platform.osLabel + " · " + state.platform.archLabel;
    label(fBody(), ImVec2(rx, ry), c.text, platformLine);
    ry += sp(21.0f);
    label(fSmall(), ImVec2(rx, ry), c.textSecondary,
          state.edition == core::Edition::Local
              ? "磁盘约 150 MB · 首次安装需联网下载"
              : "磁盘约 150 MB · 局域网端口需可访问");
    ry += sp(18.0f);
    if (!state.platform.appRuntimeSupported) {
      labelWrapped(fSmall(), ImVec2(rx, ry), c.warning,
                   state.platform.runtimeNote, rightInner.size().x);
    } else if (state.installed) {
      labelWrapped(fSmall(), ImVec2(rx, ry), c.warning,
                   "检测到已安装版本，部署将覆盖程序文件并保留数据目录。",
                   rightInner.size().x);
    }
  }

  // ---- 底部操作
  setCursor(x, bottomY);
  if (secondaryButton("返回", ImVec2(sp(110.0f), sp(44.0f)))) {
    state.screen = Screen::Welcome;
  }
  const float startW = sp(184.0f);
  const float hintW = sp(300.0f);
  setCursor(x + w - startW, bottomY - sp(2.0f));
  if (primaryButton("开始部署", ImVec2(startW, sp(48.0f)))) {
    mes::startDeployment(state);
  }
  const std::string hintText = "预计 1–3 分钟 · 安装包约 43 MB";
  label(fSmall(), ImVec2(x + w - startW - sp(16.0f) - hintW,
                         bottomY + sp(16.0f)),
        c.textTertiary, hintText);
}

// ---------------------------------------------------------------- 安装页
std::vector<core::Step> fallbackSteps() {
  std::vector<core::Step> steps;
  const char* titles[] = {"检查系统兼容性", "获取安装包", "校验安装包",
                          "解压应用文件", "写入配置与环境变量",
                          "安装服务 / 启动应用", "健康检查"};
  for (const char* title : titles) {
    core::Step step;
    step.id = title;
    step.title = title;
    step.state = core::StepState::Pending;
    steps.push_back(step);
  }
  return steps;
}

void drawStepIcon(const core::Step& step, float cx, float cy, float phase) {
  const Palette& c = theme().colors;
  ImDrawList* draw = dl();
  switch (step.state) {
    case core::StepState::Done:
      draw->AddCircleFilled(ImVec2(cx, cy), sp(10.0f), withAlpha(c.success, 0.16f),
                            24);
      paint::checkmark(draw, ImVec2(cx, cy), sp(13.0f), c.success, sp(2.0f));
      break;
    case core::StepState::Running:
      setCursor(cx - sp(9.0f), cy - sp(9.0f));
      spinner(sp(9.0f), sp(2.4f), phase);
      break;
    case core::StepState::Failed:
      draw->AddCircleFilled(ImVec2(cx, cy), sp(10.0f), withAlpha(c.danger, 0.16f),
                            24);
      paint::cross(draw, ImVec2(cx, cy), sp(14.0f), c.danger, sp(2.0f));
      break;
    case core::StepState::Skipped:
      draw->AddCircleFilled(ImVec2(cx, cy), sp(10.0f),
                            withAlpha(c.textTertiary, 0.16f), 24);
      paintIcon(draw, ImVec2(cx, cy), sp(11.0f), Icon::Minus, c.textTertiary, 1.4f);
      break;
    default:
      draw->AddCircle(ImVec2(cx, cy), sp(9.0f), withAlpha(c.textTertiary, 0.5f),
                      24, sp(1.3f));
      break;
  }
}

void drawInstallingPage(AppState& state) {
  const Theme& t = theme();
  const Palette& c = t.colors;
  const float x = contentX();
  const float w = contentWidth();
  const bool busy = state.busy;
  std::vector<core::Step> steps = state.uiProgress.steps;
  if (steps.empty()) steps = fallbackSteps();
  const int percent = state.uiProgress.percent;
  std::string currentTitle = state.uiProgress.message;
  if (currentTitle.empty()) {
    for (const core::Step& step : steps) {
      if (step.state == core::StepState::Running) {
        currentTitle = step.title;
        break;
      }
    }
  }
  if (currentTitle.empty()) currentTitle = busy ? "正在准备…" : "等待开始部署";

  pageHeader("正在部署", "请保持窗口打开，可随时取消并清理临时文件。");
  const std::string percentStr = percentText(percent);
  label(fHero(), ImVec2(x + w - measure(fHero(), percentStr).x,
                        contentTop() - sp(6.0f)),
        c.accent, percentStr);

  // 进度条
  setCursor(x, contentTop() + sp(62.0f));
  setLayoutWidth(w);
  progressBar(static_cast<float>(percent) / 100.0f, ImVec2(w, sp(10.0f)));
  const float stepLineY = contentTop() + sp(84.0f);
  paintIcon(dl(), ImVec2(x + sp(8.0f), stepLineY + sp(8.0f)), sp(12.0f),
            Icon::Refresh, c.accent, 1.4f);
  label(fBody(), ImVec2(x + sp(22.0f), stepLineY), c.text,
        "当前步骤 · " + currentTitle);
  {
    const std::string logPath = state.uiResult.logPath.empty()
                                    ? core::logFilePath(state.options)
                                    : state.uiResult.logPath;
    const std::string shown =
        elideText("日志：" + prettyPath(logPath), sp(330.0f), fSmall());
    label(fSmall(),
          ImVec2(x + w - measure(fSmall(), shown).x, stepLineY + sp(3.0f)),
          c.textTertiary, shown);
  }

  const float cardsY = contentTop() + sp(112.0f);
  const float bottomY = contentBottom() - sp(16.0f) - sp(44.0f);
  const float cardH = bottomY - sp(18.0f) - cardsY;
  const float gap = sp(20.0f);
  const float leftW = w * 0.355f;
  const float rightW = w - leftW - gap;

  // ---- 左侧步骤
  setCursor(x, cardsY);
  Rect leftInner = card("installing-steps", ImVec2(leftW, cardH), sp(20.0f), true);
  setLayoutWidth(leftInner.size().x);
  label(fMedium(), ImVec2(leftInner.min.x, leftInner.min.y), c.text, "部署步骤");
  {
    const std::string countText =
        percentText(percent) + " · " + std::to_string(steps.size()) + " 步";
    label(fSmall(),
          ImVec2(leftInner.max.x - measure(fSmall(), countText).x,
                 leftInner.min.y + sp(3.0f)),
          c.textTertiary, countText);
  }
  float rowY = leftInner.min.y + sp(34.0f);
  const float rowsAvail = leftInner.max.y - rowY;
  const float rowH =
      std::min(sp(46.0f), rowsAvail / static_cast<float>(std::max<size_t>(1, steps.size())));
  for (size_t i = 0; i < steps.size(); ++i) {
    const core::Step& step = steps[i];
    const Rect row{ImVec2(leftInner.min.x - sp(6.0f), rowY),
                   ImVec2(leftInner.max.x + sp(6.0f), rowY + rowH)};
    const bool running = step.state == core::StepState::Running;
    if (running) {
      dl()->AddRectFilled(row.min, row.max, withAlpha(c.accent, 0.10f),
                          sp(10.0f));
      dl()->AddRect(row.min, row.max, withAlpha(c.accent, 0.22f), sp(10.0f), 0,
                    sp(0.9f));
    }
    drawStepIcon(step, leftInner.min.x + sp(12.0f), row.center().y,
                 state.spinnerPhase);
    const ImU32 titleColor = running ? c.accent
                                     : (step.state == core::StepState::Done
                                            ? c.text
                                            : (step.state == core::StepState::Failed
                                                   ? c.danger
                                                   : c.textSecondary));
    label(running ? fMedium() : fBody(),
          ImVec2(leftInner.min.x + sp(30.0f), row.center().y - sp(17.0f)),
          titleColor, step.title);
    if (!step.detail.empty() && rowH >= sp(38.0f)) {
      label(fSmall(),
            ImVec2(leftInner.min.x + sp(30.0f), row.center().y + sp(1.0f)),
            c.textTertiary,
            elideText(step.detail, leftInner.size().x - sp(38.0f), fSmall()));
    }
    rowY += rowH;
  }

  // ---- 右侧日志
  setCursor(x + leftW + gap, cardsY);
  Rect rightInner = card("installing-logs", ImVec2(rightW, cardH), sp(20.0f), false);
  setLayoutWidth(rightInner.size().x);
  const float headerY = rightInner.min.y;
  label(fMedium(), ImVec2(rightInner.min.x, headerY), c.text, "安装日志");
  {
    const std::string countText = std::to_string(state.uiLogs.size()) + " 行";
    setCursor(rightInner.min.x + measure(fMedium(), "安装日志").x + sp(10.0f),
              headerY + sp(3.0f));
    badge(countText.c_str(), withAlpha(c.accent, 0.10f), c.accent);
  }
  const float copyW = sp(64.0f);
  setCursor(rightInner.max.x - copyW, headerY - sp(1.0f));
  setLayoutWidth(copyW);
  if (quietButton("复制全部", ImVec2(copyW, sp(26.0f)))) {
    std::string all;
    for (const LogLine& line : state.uiLogs) {
      all += line.level + "  " + line.text + "\n";
    }
    ImGui::SetClipboardText(all.c_str());
    mes::notify(state, "安装日志已复制到剪贴板", false);
  }
  {
    const std::string autoText = state.logAutoScroll ? "自动滚动" : "已暂停滚动";
    label(fSmall(),
          ImVec2(rightInner.max.x - copyW - sp(12.0f) -
                     measure(fSmall(), autoText).x,
                 headerY + sp(6.0f)),
          state.logAutoScroll ? c.textTertiary : c.warning, autoText);
  }

  const Rect logPanel{ImVec2(rightInner.min.x, rightInner.min.y + sp(34.0f)),
                      ImVec2(rightInner.max.x, rightInner.max.y)};
  ImDrawList* draw = dl();
  draw->AddRectFilled(logPanel.min, logPanel.max,
                      withAlpha(IM_COL32(255, 255, 255, 255), 0.42f), sp(12.0f));
  draw->AddRect(logPanel.min, logPanel.max,
                withAlpha(c.textTertiary, 0.20f), sp(12.0f), 0, sp(0.9f));
  const float padX = sp(12.0f);
  const float padY = sp(8.0f);
  const float lineH = sp(17.0f);
  const float areaH = logPanel.size().y - padY * 2.0f;
  const float areaW = logPanel.size().x - padX * 2.0f;
  const size_t count = state.uiLogs.size();
  const float maxScroll = std::max(0.0f, static_cast<float>(count) * lineH - areaH);
  if (state.logAutoScroll) {
    state.logScroll = maxScroll;
  } else {
    state.logScroll = std::max(0.0f, std::min(maxScroll, state.logScroll));
  }
  // 滚轮
  if (!pageBlocked(state) &&
      ImGui::IsMouseHoveringRect(logPanel.min, logPanel.max)) {
    const float wheel = ImGui::GetIO().MouseWheel;
    if (wheel > 0.0f) {
      state.logAutoScroll = false;
      state.logScroll = std::max(0.0f, state.logScroll - wheel * lineH * 3.0f);
    } else if (wheel < 0.0f) {
      state.logScroll =
          std::min(maxScroll, state.logScroll - wheel * lineH * 3.0f);
      if (state.logScroll >= maxScroll - 0.5f) state.logAutoScroll = true;
    }
    if (ImGui::IsMouseDragging(ImGuiMouseButton_Left) &&
        !ImGui::IsAnyItemActive()) {
      // 拖动滚动（轻量实现）
    }
  }
  draw->PushClipRect(logPanel.min, logPanel.max, true);
  if (count == 0) {
    label(fSmall(), ImVec2(logPanel.min.x + padX, logPanel.min.y + padY),
          c.textTertiary, "等待安装日志…");
  } else {
    const float first = std::floor(state.logScroll / lineH);
    const float fraction = state.logScroll - first * lineH;
    const int visible = static_cast<int>(std::ceil(areaH / lineH)) + 1;
    for (int i = 0; i < visible; ++i) {
      const int index = static_cast<int>(first) + i;
      if (index < 0 || static_cast<size_t>(index) >= count) continue;
      const LogLine& line = state.uiLogs[static_cast<size_t>(index)];
      const float lineY = logPanel.min.y + padY +
                          static_cast<float>(i) * lineH - fraction;
      if (lineY < logPanel.min.y + padY - lineH ||
          lineY > logPanel.max.y - padY)
        continue;
      const ImU32 color = levelColor(line.level);
      draw->AddCircleFilled(
          ImVec2(logPanel.min.x + padX + sp(3.0f), lineY + sp(8.0f)), sp(2.6f),
          color, 10);
      const std::string tag = "[" + levelTag(line.level) + "]";
      label(fSmall(), ImVec2(logPanel.min.x + padX + sp(12.0f), lineY),
            withAlpha(color, 0.85f), tag);
      const float tagW = measure(fSmall(), tag).x;
      label(fSmall(), ImVec2(logPanel.min.x + padX + sp(18.0f) + tagW, lineY),
            color, elideText(line.text, areaW - tagW - sp(30.0f), fSmall()));
    }
  }
  draw->PopClipRect();
  if (!state.logAutoScroll) {
    const float gotoW = sp(84.0f);
    setCursor(logPanel.max.x - gotoW - sp(10.0f),
              logPanel.max.y - sp(32.0f));
    setLayoutWidth(gotoW);
    if (quietButton("回到最新", ImVec2(gotoW, sp(24.0f)))) {
      state.logAutoScroll = true;
    }
  }

  // ---- 底部
  setCursor(x, bottomY);
  const std::string logPath = core::logFilePath(state.options);
  label(fSmall(), ImVec2(x, bottomY + sp(14.0f)), c.textTertiary,
        "日志文件：" + elideText(prettyPath(logPath), w - sp(360.0f), fSmall()));
  if (busy) {
    const float cancelW = sp(140.0f);
    setCursor(x + w - cancelW, bottomY);
    if (state.cancelRequested) {
      secondaryButton("正在取消…", ImVec2(cancelW, sp(44.0f)), true);
    } else {
      if (dangerButton("取消部署", ImVec2(cancelW, sp(44.0f)))) {
        state.showCancelConfirm = true;
      }
    }
  } else {
    const float backW = sp(132.0f);
    setCursor(x + w - backW, bottomY);
    if (secondaryButton("返回配置", ImVec2(backW, sp(44.0f)))) {
      state.screen = Screen::Configure;
    }
  }
}

// ---------------------------------------------------------------- 结果页
void drawRecentLogs(const AppState& state, const Rect& rect, int maxLines) {
  const Palette& c = theme().colors;
  ImDrawList* draw = dl();
  draw->AddRectFilled(rect.min, rect.max,
                      withAlpha(IM_COL32(255, 255, 255, 255), 0.42f), sp(12.0f));
  draw->AddRect(rect.min, rect.max, withAlpha(c.textTertiary, 0.20f),
                sp(12.0f), 0, sp(0.9f));
  const float pad = sp(12.0f);
  const float lineH = sp(17.0f);
  const size_t total = state.uiLogs.size();
  const int take = std::min<int>(maxLines, static_cast<int>(total));
  draw->PushClipRect(rect.min, rect.max, true);
  for (int i = 0; i < take; ++i) {
    const LogLine& line = state.uiLogs[total - static_cast<size_t>(take) +
                                       static_cast<size_t>(i)];
    const float lineY = rect.min.y + pad + static_cast<float>(i) * lineH;
    const ImU32 color = levelColor(line.level);
    label(fSmall(), ImVec2(rect.min.x + pad, lineY), color,
          elideText(line.text, rect.size().x - pad * 2.0f, fSmall()));
  }
  draw->PopClipRect();
}

void drawResultPage(AppState& state) {
  const Theme& t = theme();
  const Palette& c = t.colors;
  const float x = contentX();
  const float w = contentWidth();
  const core::DeploymentResult& result = state.uiResult;
  const bool cancelled = result.cancelled;
  const bool known = state.uiResultReady || state.previewData || result.ok ||
                     !result.error.empty();
  const bool success = result.ok && !cancelled;

  if (!known) {
    pageHeader("暂无部署结果", "还没有运行过部署；返回欢迎页开始一次安装。");
    const float buttonY = contentBottom() - sp(20.0f) - sp(48.0f);
    setCursor(x, buttonY);
    if (primaryButton("返回欢迎", ImVec2(sp(148.0f), sp(48.0f)))) {
      mes::resetToWelcome(state);
    }
    return;
  }

  const bool preview = state.previewData && !state.uiResultReady;
  const float headerY = contentTop();
  const Icon headerIcon = success ? Icon::Check
                                  : (cancelled ? Icon::Clock : Icon::Cross);
  const ImU32 headerFrom = success ? IM_COL32(74, 222, 128, 255)
                                   : (cancelled ? IM_COL32(255, 214, 102, 255)
                                                : IM_COL32(255, 120, 110, 255));
  const ImU32 headerTo = success ? IM_COL32(34, 170, 84, 255)
                                 : (cancelled ? IM_COL32(230, 160, 20, 255)
                                              : IM_COL32(214, 52, 44, 255));
  iconBadge(dl(), ImVec2(x + sp(30.0f), headerY + sp(30.0f)), sp(30.0f),
            headerIcon, headerFrom, headerTo, 0.48f);
  label(fHero(), ImVec2(x + sp(78.0f), headerY - sp(6.0f)), c.text,
        success ? "部署完成" : (cancelled ? "已取消部署" : "部署失败"));
  label(fBody(), ImVec2(x + sp(80.0f), headerY + sp(42.0f)), c.textSecondary,
        success
            ? "校园作业分析已准备就绪，可以通过下面的地址访问。"
            : (cancelled ? "安装已中止，临时文件已清理，可返回配置重新开始。"
                         : "安装没有完成，请查看错误信息与日志后重试。"));
  if (preview) {
    setCursor(x + w - sp(104.0f), headerY + sp(4.0f));
    badge("演示预览", withAlpha(c.warning, 0.14f), c.warning);
  }

  const float cardY = contentTop() + sp(88.0f);
  setCursor(x, cardY);

  if (success) {
    const float cardH = sp(246.0f);
    Rect inner = card("result-card", ImVec2(w, cardH), sp(20.0f), true);
    setLayoutWidth(inner.size().x);
    const std::string url = result.url.empty()
                                ? "http://127.0.0.1:" + std::to_string(state.options.port)
                                : result.url;
    const std::string installDir = result.installDir.empty()
                                       ? state.options.installDir
                                       : result.installDir;
    const std::string dataDir = core::defaultDataDir(state.options);
    const std::string logPath = result.logPath.empty()
                                    ? core::logFilePath(state.options)
                                    : result.logPath;
    float rowY = inner.min.y;
    label(fSmall(), ImVec2(inner.min.x, rowY + sp(6.0f)), c.textTertiary,
          "访问地址");
    setCursor(inner.min.x + sp(92.0f), rowY + sp(2.0f));
    setLayoutWidth(inner.size().x - sp(92.0f));
    linkText("result-url", url, sp(430.0f));
    {
      const float openW = sp(118.0f);
      const float copyW = sp(84.0f);
      setCursor(inner.max.x - openW - copyW - sp(10.0f), rowY);
      setLayoutWidth(openW);
      if (actionButton("result-openbrowser", Icon::External, "打开浏览器",
                       ImVec2(openW, sp(32.0f)), false, false)) {
        platform::openBrowser(url);
      }
      setCursor(inner.max.x - copyW, rowY);
      setLayoutWidth(copyW);
      if (quietButton("复制", ImVec2(copyW, sp(32.0f)))) {
        ImGui::SetClipboardText(url.c_str());
        mes::notify(state, "访问地址已复制", false);
      }
    }
    rowY += sp(44.0f);
    paint::hairline(dl(), inner.min.x, inner.max.x, rowY, 0.9f);
    rowY += sp(8.0f);

    struct PathRow {
      const char* label;
      std::string value;
      const char* action;
      const char* id;
      Icon icon;
    };
    PathRow rows[] = {
        {"安装目录", prettyPath(installDir), "打开文件夹", "result-open-dir",
         Icon::Folder},
        {"数据目录", prettyPath(dataDir), "打开文件夹", "result-open-data",
         Icon::Folder},
        {"日志文件", prettyPath(logPath), "查看日志", "result-open-log",
         Icon::Terminal},
    };
    for (const PathRow& row : rows) {
      label(fSmall(), ImVec2(inner.min.x, rowY + sp(2.0f)), c.textTertiary,
            row.label);
      label(fBody(), ImVec2(inner.min.x + sp(92.0f), rowY), c.text,
            elideText(row.value, inner.size().x - sp(300.0f), fBody()));
      const float actionW = sp(112.0f);
      setCursor(inner.max.x - actionW, rowY - sp(4.0f));
      setLayoutWidth(actionW);
      if (actionButton(row.id, row.icon, row.action,
                       ImVec2(actionW, sp(30.0f)), false, false)) {
        platform::revealPath(row.value);
      }
      rowY += sp(34.0f);
    }
    rowY += sp(2.0f);
    paint::hairline(dl(), inner.min.x, inner.max.x, rowY, 0.9f);
    rowY += sp(12.0f);
    const bool serviceShownRunning =
        state.serviceRunning || (result.ok && (preview || state.demoMode));
    setCursor(inner.min.x, rowY);
    statusDot(serviceShownRunning ? c.success : c.textTertiary, sp(4.5f));
    const float dotEnd = ImGui::GetCursorScreenPos().x;
    label(fSmall(), ImVec2(dotEnd, rowY - sp(1.0f)), c.textSecondary,
          serviceShownRunning ? "服务运行中" : "服务未运行");
    setCursor(dotEnd + measure(fSmall(), "服务运行中").x + sp(18.0f), rowY - sp(2.0f));
    badge(("版本 " + std::string(core::kVersion)).c_str(),
          withAlpha(c.accent, 0.10f), c.accent);
    if (preview) {
      badge("演示数据", withAlpha(c.warning, 0.14f), c.warning);
    }

    // 操作按钮
    const float actionsY = cardY + cardH + sp(22.0f);
    setCursor(x, actionsY);
    if (actionButton("result-openapp", Icon::Play, "打开应用",
                     ImVec2(sp(150.0f), sp(48.0f)), true, false)) {
      mes::startOpenApp(state);
    }
    setCursor(x + sp(162.0f), actionsY + sp(2.0f));
    if (actionButton("result-stop", Icon::Stop, "停止服务",
                     ImVec2(sp(132.0f), sp(44.0f)), false, false)) {
      if (state.serviceRunning || serviceShownRunning) {
        mes::startStop(state);
      } else {
        mes::notify(state, "服务当前未运行", false);
      }
    }
    setCursor(x + sp(306.0f), actionsY + sp(2.0f));
    if (actionButton("result-uninstall", Icon::Trash, "卸载",
                     ImVec2(sp(104.0f), sp(44.0f)), false, true)) {
      state.confirmUninstall = true;
    }
    const float backW = sp(120.0f);
    setCursor(x + w - backW, actionsY + sp(2.0f));
    if (quietButton("返回欢迎", ImVec2(backW, sp(44.0f)))) {
      mes::resetToWelcome(state);
    }
    label(fSmall(), ImVec2(x, actionsY + sp(56.0f)), c.textTertiary,
          "卸载默认保留数据目录；如需彻底清除，请在确认框中勾选“同时删除数据目录”。");

    // 底部建议卡片（填补留白）
    const float tipY = actionsY + sp(78.0f);
    const float tipH = sp(92.0f);
    setCursor(x, tipY);
    Rect tip = card("result-tips", ImVec2(w, tipH), sp(18.0f), false);
    setLayoutWidth(tip.size().x);
    label(fSmall(), ImVec2(tip.min.x, tip.min.y), c.textTertiary, "接下来");
    struct Tip {
      Icon icon;
      const char* title;
      const char* desc;
    };
    static const Tip tips[] = {
        {Icon::Globe, "收藏访问地址", "把地址加入浏览器书签，方便随时打开"},
        {Icon::Stop, "随时停止服务", "在结果页或系统服务管理器中停止"},
        {Icon::Server, "多人使用？", "部署服务器版，让同学与老师同时访问"},
    };
    const float colW = tip.size().x / 3.0f;
    for (int i = 0; i < 3; ++i) {
      const float ix = tip.min.x + colW * static_cast<float>(i);
      iconBadge(dl(), ImVec2(ix + sp(16.0f), tip.min.y + sp(48.0f)), sp(14.0f),
                tips[i].icon, withAlpha(c.accent, 0.55f),
                withAlpha(c.accentDeep, 0.85f), 0.48f);
      label(fMedium(), ImVec2(ix + sp(38.0f), tip.min.y + sp(28.0f)), c.text,
            tips[i].title);
      label(fSmall(), ImVec2(ix + sp(38.0f), tip.min.y + sp(50.0f)),
            c.textSecondary,
            elideText(tips[i].desc, colW - sp(48.0f), fSmall()));
    }
  } else {
    const float bannerH = std::max(sp(70.0f),
                                   measureWrappedHeight(fBody(),
                                                        result.error.empty()
                                                            ? "未知错误"
                                                            : result.error.c_str(),
                                                        w - sp(120.0f)) +
                                       sp(36.0f));
    setCursor(x, cardY);
    setLayoutWidth(w);
    if (banner("result-error",
               result.error.empty() ? "部署失败，但没有返回详细错误信息。"
                                    : result.error,
               true)) {
      state.bannerText.clear();
    }
    const float logsY = cardY + bannerH + sp(18.0f);
    const float logsH = sp(150.0f);
    setCursor(x, logsY);
    Rect logsInner = card("result-logs", ImVec2(w, logsH), sp(20.0f), false);
    label(fSmall(), ImVec2(logsInner.min.x, logsInner.min.y), c.textTertiary,
          "最近日志");
    const Rect logsPanel{ImVec2(logsInner.min.x, logsInner.min.y + sp(22.0f)),
                         logsInner.max};
    drawRecentLogs(state, logsPanel, 7);

    const float actionsY = logsY + logsH + sp(22.0f);
    setCursor(x, actionsY);
    if (actionButton("result-retry", Icon::Refresh, "重试",
                     ImVec2(sp(132.0f), sp(48.0f)), true, false)) {
      mes::startDeployment(state);
    }
    setCursor(x + sp(144.0f), actionsY + sp(2.0f));
    if (secondaryButton("返回修改", ImVec2(sp(132.0f), sp(44.0f)))) {
      state.screen = Screen::Configure;
    }
    setCursor(x + sp(288.0f), actionsY + sp(2.0f));
    if (actionButton("result-openlogdir", Icon::Folder, "打开日志目录",
                     ImVec2(sp(156.0f), sp(44.0f)), false, false)) {
      platform::revealPath(result.logPath.empty()
                               ? core::logFilePath(state.options)
                               : result.logPath);
    }
    const float backW = sp(120.0f);
    setCursor(x + w - backW, actionsY + sp(2.0f));
    if (quietButton("返回欢迎", ImVec2(backW, sp(44.0f)))) {
      mes::resetToWelcome(state);
    }
  }
}

// ---------------------------------------------------------------- 关于
// 返回矩阵绘制结束后的下一个可放置 Y 坐标（含 32 位运行时提示小卡）。
float drawPlatformMatrix(float x, float y, float width) {
  const Palette& c = theme().colors;
  ImDrawList* draw = dl();
  const char* columns[] = {"x64", "x86", "arm64"};
  const float colW = sp(76.0f);
  const float nameW = width - colW * 3.0f;
  float cx = x + nameW;
  for (int i = 0; i < 3; ++i) {
    label(fSmall(),
          ImVec2(cx + (colW - measure(fSmall(), columns[i]).x) * 0.5f, y),
          c.textTertiary, columns[i]);
    cx += colW;
  }
  y += sp(21.0f);
  paint::hairline(draw, x, x + width, y, 0.7f);
  y += sp(9.0f);

  struct Row {
    const char* name;
    bool support[3];
  };
  const Row rows[] = {
      {"Windows 10 / 11", {true, true, true}},
      {"Debian / RHEL / 银河麒麟", {true, true, true}},
      {"macOS（Apple Silicon）", {false, false, true}},
  };
  for (const Row& row : rows) {
    label(fBody(), ImVec2(x, y), c.text, row.name);
    for (int i = 0; i < 3; ++i) {
      const ImVec2 center(x + nameW + colW * static_cast<float>(i) + colW * 0.5f,
                          y + sp(9.0f));
      if (row.support[i]) {
        paint::checkmark(draw, center, sp(13.0f), c.success, sp(1.8f));
      } else {
        draw->AddLine(ImVec2(center.x - sp(4.5f), center.y),
                      ImVec2(center.x + sp(4.5f), center.y),
                      withAlpha(c.textTertiary, 0.6f), sp(1.3f));
      }
    }
    y += sp(26.0f);
  }

  // 32 位运行时限制：独立玻璃小卡，保证与下一节标题不重叠。
  y += sp(8.0f);
  const std::string note =
      "32 位（x86）系统可以运行部署器，但官方 Node.js 24 不再提供 32 位运行时，"
      "应用需要 64 位设备或服务器。";
  const float noteTextW = width - sp(46.0f);
  const float noteH =
      measureWrappedHeight(fSmall(), note.c_str(), noteTextW) + sp(20.0f);
  const Rect noteRect{ImVec2(x, y), ImVec2(x + width, y + noteH)};
  draw->AddRectFilled(noteRect.min, noteRect.max, withAlpha(c.warning, 0.08f),
                      sp(10.0f));
  draw->AddRect(noteRect.min, noteRect.max, withAlpha(c.warning, 0.22f),
                sp(10.0f), 0, sp(0.9f));
  paintIcon(draw,
            ImVec2(noteRect.min.x + sp(16.0f), noteRect.min.y + sp(16.0f)),
            sp(12.0f), Icon::Warning, withAlpha(c.warning, 0.9f), 1.3f);
  labelWrapped(fSmall(),
               ImVec2(noteRect.min.x + sp(30.0f), noteRect.min.y + sp(9.0f)),
               c.textSecondary, note, noteTextW);
  return noteRect.max.y;
}

void drawAboutPage(AppState& state) {
  const Theme& t = theme();
  const Palette& c = t.colors;
  const ImVec2 display = displaySize();
  modalScrim(0.34f);

  const float cardW = std::min(sp(780.0f), display.x - sp(160.0f));
  const float cardH = std::min(sp(620.0f), display.y - sp(80.0f));
  const ImVec2 p(display.x * 0.5f - cardW * 0.5f,
                 display.y * 0.5f - cardH * 0.5f);
  const Rect rect{p, ImVec2(p.x + cardW, p.y + cardH)};
  paint::glassPanel(dl(), rect.min, rect.max, sp(24.0f), true);
  const float pad = sp(30.0f);
  const float innerW = cardW - pad * 2.0f;

  // ---- 固定头部
  const float headerTop = rect.min.y + pad;
  iconBadge(dl(), ImVec2(rect.min.x + pad + sp(26.0f), headerTop + sp(26.0f)),
            sp(26.0f), Icon::Sparkle, c.accentLight, c.accentDeep, 0.5f);
  label(fTitle(), ImVec2(rect.min.x + pad + sp(66.0f), headerTop + sp(2.0f)),
        c.text, "校园作业分析 · 桌面部署器");
  label(fSmall(), ImVec2(rect.min.x + pad + sp(68.0f), headerTop + sp(34.0f)),
        c.textSecondary,
        std::string("版本 ") + core::kVersion + " · 构建 " + core::kBuild +
            " · 开源许可 MIT");
  setCursor(rect.max.x - pad - sp(32.0f), headerTop - sp(2.0f));
  if (iconButton("about-close", "×", ImVec2(sp(32.0f), sp(32.0f)), "关闭")) {
    closeAbout(state);
  }
  const float headerH = sp(78.0f);

  // ---- 固定底部：powered by DSH 徽章 + 关闭按钮
  const float footerY = rect.max.y - pad - sp(34.0f);
  drawDshBadge(rect.min.x + pad, footerY);
  const float closeW = sp(108.0f);
  setCursor(rect.max.x - pad - closeW, footerY - sp(3.0f));
  if (primaryButton("关闭", ImVec2(closeW, sp(40.0f)))) {
    closeAbout(state);
  }
  const float footerH = sp(64.0f);

  // ---- 可滚动内容区
  const Rect view{ImVec2(rect.min.x + pad, headerTop + headerH),
                  ImVec2(rect.max.x - pad, rect.max.y - pad - footerH)};
  const float contentH = sp(402.0f);
  const float viewH = view.size().y;
  const float maxScroll = std::max(0.0f, contentH - viewH);
  if (maxScroll > 0.5f && !interactionBlocked() &&
      ImGui::IsMouseHoveringRect(view.min, view.max)) {
    state.aboutScroll -= ImGui::GetIO().MouseWheel * sp(40.0f);
  }
  state.aboutScroll = std::max(0.0f, std::min(maxScroll, state.aboutScroll));

  ImDrawList* draw = dl();
  draw->PushClipRect(view.min, view.max, true);
  float y = view.min.y - state.aboutScroll;

  // 许可 + 仓库
  setCursor(rect.min.x + pad, y);
  badge("MIT License", withAlpha(c.success, 0.12f), c.success);
  label(fBody(), ImVec2(rect.min.x + pad + sp(118.0f), y + sp(1.0f)),
        c.textSecondary, "GitHub 仓库：");
  setCursor(rect.min.x + pad + sp(214.0f), y + sp(1.0f));
  setLayoutWidth(sp(400.0f));
  const std::string repo = std::string("github.com/") + core::kRepoSlug;
  if (linkText("about-repo", repo, sp(400.0f), "在浏览器中打开 GitHub 仓库")) {
    platform::openBrowser(std::string("https://github.com/") + core::kRepoSlug);
  }
  y += sp(38.0f);
  paint::hairline(draw, rect.min.x + pad, rect.max.x - pad, y, 0.8f);
  y += sp(18.0f);

  label(fMedium(), ImVec2(rect.min.x + pad, y), c.text, "支持的平台");
  y += sp(28.0f);
  y = drawPlatformMatrix(rect.min.x + pad, y, innerW);
  y += sp(16.0f);
  paint::hairline(draw, rect.min.x + pad, rect.max.x - pad, y, 0.8f);
  y += sp(18.0f);

  label(fMedium(), ImVec2(rect.min.x + pad, y), c.text, "技术栈与依赖");
  y += sp(28.0f);
  struct Dep {
    Icon icon;
    const char* name;
    const char* desc;
  };
  const Dep deps[] = {
      {Icon::Cpu, "GLFW 3.4", "窗口、输入与 OpenGL 上下文"},
      {Icon::Sparkle, "Dear ImGui 1.91", "自绘 Apple 风格界面与控件"},
      {Icon::Folder, "miniz 3.0", "ZIP 解压与安装包校验"},
  };
  for (const Dep& dep : deps) {
    paintIcon(draw, ImVec2(rect.min.x + pad + sp(10.0f), y + sp(9.0f)),
              sp(13.0f), dep.icon, withAlpha(c.accent, 0.9f), 1.3f);
    label(fBody(), ImVec2(rect.min.x + pad + sp(26.0f), y), c.text, dep.name);
    label(fSmall(),
          ImVec2(rect.min.x + pad + sp(26.0f) + measure(fBody(), dep.name).x +
                     sp(12.0f),
                 y + sp(3.0f)),
          c.textSecondary, dep.desc);
    y += sp(24.0f);
  }
  y += sp(6.0f);
  labelWrapped(fSmall(), ImVec2(rect.min.x + pad, y), c.textTertiary,
               "依赖均在构建时静态编译，部署器无运行时第三方依赖；安装包与部署日志"
               "均为本地处理，不会上传云端。",
               innerW);
  draw->PopClipRect();

  // 滚动条指示（窗口较小时可用滚轮滚动）
  if (maxScroll > 0.5f) {
    const float trackX = rect.max.x - pad + sp(10.0f);
    const float thumbH = std::max(sp(24.0f), viewH * (viewH / contentH));
    const float thumbY =
        view.min.y + (viewH - thumbH) * (state.aboutScroll / maxScroll);
    draw->AddRectFilled(ImVec2(trackX, view.min.y),
                        ImVec2(trackX + sp(3.0f), view.min.y + viewH),
                        withAlpha(c.textTertiary, 0.12f), sp(2.0f));
    draw->AddRectFilled(ImVec2(trackX, thumbY),
                        ImVec2(trackX + sp(3.0f), thumbY + thumbH),
                        withAlpha(c.textTertiary, 0.45f), sp(2.0f));
  }
}
}  // namespace

// ---------------------------------------------------------------- 对外接口
void drawBackground() {
  prepareRootWindow();
  syncFontScale();
  ImDrawList* draw = dl();
  const ImVec2 display = displaySize();
  const Palette& c = theme().colors;
  draw->AddRectFilledMultiColor(ImVec2(0, 0), display, c.backgroundTop,
                                c.backgroundTop, c.backgroundBottom,
                                c.backgroundBottom);
  // 低饱和光晕
  paint::spotlight(draw, ImVec2(display.x * 0.10f, display.y * 0.02f),
                   display.x * 0.62f, withAlpha(IM_COL32(96, 160, 255, 255), 0.30f));
  paint::spotlight(draw, ImVec2(display.x * 0.95f, display.y * 0.12f),
                   display.x * 0.46f,
                   withAlpha(IM_COL32(170, 150, 255, 255), 0.22f));
  paint::spotlight(draw, ImVec2(display.x * 0.68f, display.y * 1.06f),
                   display.x * 0.52f,
                   withAlpha(IM_COL32(120, 215, 220, 255), 0.20f));
  // 顶部细光
  draw->AddRectFilledMultiColor(ImVec2(0, 0), ImVec2(display.x, sp(2.0f)),
                                IM_COL32(255, 255, 255, 150),
                                IM_COL32(255, 255, 255, 150),
                                IM_COL32(255, 255, 255, 0),
                                IM_COL32(255, 255, 255, 0));
}

void drawTopBar(AppState& state) {
  setInteractionBlocked(pageBlocked(state));
  const Theme& t = theme();
  const Palette& c = t.colors;
  ImDrawList* draw = dl();
  const ImVec2 display = displaySize();
  const float h = t.topBarHeight;
  draw->AddRectFilledMultiColor(
      ImVec2(0, 0), ImVec2(display.x, h), IM_COL32(255, 255, 255, 160),
      IM_COL32(255, 255, 255, 160), IM_COL32(255, 255, 255, 30),
      IM_COL32(255, 255, 255, 30));
  paint::hairline(draw, 0, display.x, h, 0.5f);

  const float x = t.margin;
  const float cy = h * 0.5f;
  iconBadge(draw, ImVec2(x + sp(15.0f), cy), sp(15.0f), Icon::Sparkle,
            c.accentLight, c.accentDeep, 0.5f);
  label(fMedium(), ImVec2(x + sp(38.0f), cy - sp(17.0f)), c.text,
        "校园作业分析");
  label(fSmall(), ImVec2(x + sp(39.0f), cy + sp(2.0f)), c.textSecondary,
        "桌面部署器");

  const float rightLimit = display.x - sp(112.0f);
  // 版本小标签
  {
    const std::string items[] = {"离线安装需完整运行时包", core::kVersion, std::string("build ") + core::kBuild};
    float totalW = 0.0f;
    for (const std::string& item : items)
      totalW += measure(fSmall(), item).x + sp(20.0f) + sp(8.0f);
    float bx = rightLimit - sp(96.0f) - totalW + sp(8.0f);
    for (int i = 0; i < 3; ++i) {
      setCursor(bx, cy - sp(12.0f));
      badge(items[i].c_str(),
            withAlpha(IM_COL32(255, 255, 255, 255), 0.58f), c.textSecondary);
      bx += measure(fSmall(), items[i]).x + sp(20.0f) + sp(8.0f);
    }
  }
  // 关于
  {
    const float buttonW = sp(88.0f);
    setCursor(rightLimit - buttonW, cy - sp(17.0f));
    setLayoutWidth(buttonW);
    if (actionButton("topbar-about", Icon::Info, "关于",
                     ImVec2(buttonW, sp(34.0f)), false, false)) {
      openAbout(state);
    }
  }
}

void drawFooter(AppState& state) {
  setInteractionBlocked(pageBlocked(state));
  const Theme& t = theme();
  const Palette& c = t.colors;
  ImDrawList* draw = dl();
  const ImVec2 display = displaySize();
  const float h = t.footerHeight;
  const float y = display.y - h;
  draw->AddRectFilled(ImVec2(0, y), display, IM_COL32(255, 255, 255, 92));
  paint::hairline(draw, 0, display.x, y, 0.7f);
  const float cy = y + h * 0.5f;

  setCursor(t.margin, cy - sp(4.5f));
  const ImU32 dotColor = state.busy
                             ? c.accent
                             : (state.installed && state.serviceRunning ? c.success
                                                                         : c.textTertiary);
  statusDot(dotColor, sp(4.5f));
  const float afterDot = ImGui::GetCursorScreenPos().x;
  const std::string platformText =
      state.platform.osLabel + " · " + state.platform.archLabel +
      std::string("    部署器 ") + core::kVersion + " · build " + core::kBuild;
  label(fSmall(), ImVec2(afterDot, cy - sp(6.0f)), c.textSecondary, platformText);
  if (state.demoMode) {
    setCursor(afterDot + measure(fSmall(), platformText).x + sp(16.0f),
              cy - sp(11.0f));
    badge("演示模式", withAlpha(c.warning, 0.14f), c.warning);
  }

  const std::string rightText =
      stateLabel(state) + "    " + clockText();
  label(fSmall(),
        ImVec2(display.x - t.margin - measure(fSmall(), rightText).x,
               cy - sp(6.0f)),
        c.textSecondary, rightText);
}

void drawToast(AppState& state) {
  setInteractionBlocked(false);
  const Theme& t = theme();
  const Palette& c = t.colors;
  ImDrawList* draw = dl();
  const ImVec2 display = displaySize();

  // 卸载二次确认
  if (state.confirmUninstall) {
    const int action = confirmDialog(
        "uninstall-dialog", "卸载校园作业分析",
        "将停止并删除程序文件与系统服务。默认保留数据目录（作业数据），"
        "之后可以重新安装并继续使用。",
        "确认卸载", "取消", true, &state.uninstallRemoveData,
        "同时删除数据目录（不可恢复）");
    if (action == 1) {
      mes::startUninstall(state);
    } else if (action == 2) {
      state.confirmUninstall = false;
    }
    setInteractionBlocked(true);
  }

  // 取消部署确认
  if (state.showCancelConfirm) {
    const int action = confirmDialog(
        "cancel-dialog", "取消部署？",
        "安装正在进行中。取消后会停止当前步骤并清理已写入的临时文件，"
        "已存在的安装不会被破坏。",
        "继续部署", "确认取消", false);
    if (action == 1) {
      state.showCancelConfirm = false;
    } else if (action == 2) {
      state.showCancelConfirm = false;
      state.cancelRequested = true;
      state.cancel = true;
      mes::notify(state, "正在取消部署…", false);
    }
    setInteractionBlocked(true);
  }

  // 关于页由 drawAbout 绘制主体，这里补一层遮罩盖住其后绘制的底部状态栏。
  if (state.screen == Screen::About) {
    const float footerY = display.y - t.footerHeight;
    draw->AddRectFilled(ImVec2(0, footerY), display, IM_COL32(18, 26, 44, 92));
  }

  // Toast：右上浮层玻璃条，2.8 秒淡出。
  if (!state.bannerText.empty()) {
    const double elapsed = state.now - state.bannerAt;
    float alpha = 1.0f;
    if (elapsed < 0.16) alpha = static_cast<float>(elapsed / 0.16);
    if (elapsed > 2.30) alpha = static_cast<float>((2.8 - elapsed) / 0.5);
    alpha = std::max(0.0f, std::min(1.0f, alpha));
    if (alpha > 0.01f) {
      const float maxW = sp(440.0f);
      const ImFont* font = fBody();
      const float textW = std::min(maxW, measure(fBody(), state.bannerText).x);
      const float h = sp(46.0f);
      const float w = textW + sp(92.0f);
      const float bx = display.x - sp(24.0f) - w;
      const float by = sp(64.0f) - static_cast<float>(1.0 - alpha) * sp(8.0f);
      const Rect rect{ImVec2(bx, by), ImVec2(bx + w, by + h)};
      ImDrawList* front = ImGui::GetWindowDrawList();
      const ImU32 tint = state.bannerError ? c.danger : c.success;
      for (int i = 3; i >= 1; --i) {
        const float off = sp(2.0f) * static_cast<float>(i);
        front->AddRectFilled(ImVec2(rect.min.x - off, rect.min.y + sp(2.0f)),
                             ImVec2(rect.max.x + off, rect.max.y + off),
                             withAlpha(c.shadowTint, 0.06f * alpha),
                             sp(14.0f) + off);
      }
      front->AddRectFilled(rect.min, rect.max,
                           withAlpha(IM_COL32(255, 255, 255, 255), 0.92f * alpha),
                           sp(14.0f));
      front->AddRect(rect.min, rect.max, withAlpha(tint, 0.45f * alpha),
                     sp(14.0f), 0, sp(1.2f));
      paint::highlight(front, rect.min, rect.max, sp(14.0f), 0.9f * alpha);
      const ImVec2 iconCenter(rect.min.x + sp(26.0f), rect.center().y);
      front->AddCircleFilled(iconCenter, sp(13.0f),
                             withAlpha(tint, 0.16f * alpha), 24);
      paintIcon(front, iconCenter, sp(16.0f),
                state.bannerError ? Icon::Warning : Icon::Check,
                withAlpha(tint, alpha), 1.6f);
      const std::string shown = elideText(state.bannerText, textW, fBody());
      drawLabel(front, fBody(),
                ImVec2(rect.min.x + sp(48.0f),
                       rect.center().y - textSize(font) * 0.5f),
                withAlpha(c.text, alpha), shown.c_str());
    }
  }

  // 恢复窗口裁剪（main 的窗口控制按钮仍需当前窗口上下文）。
  draw->PopClipRect();
}

void drawWelcome(AppState& state) {
  setInteractionBlocked(pageBlocked(state));
  drawWelcomePage(state);
}

void drawConfigure(AppState& state) {
  setInteractionBlocked(pageBlocked(state));
  drawConfigurePage(state);
}

void drawInstalling(AppState& state) {
  setInteractionBlocked(pageBlocked(state));
  drawInstallingPage(state);
}

void drawResult(AppState& state) {
  setInteractionBlocked(pageBlocked(state));
  drawResultPage(state);
}

void drawAbout(AppState& state, bool asModal) {
  (void)asModal;
  setInteractionBlocked(false);
  drawAboutPage(state);
  setInteractionBlocked(true);
}

}  // namespace mes::ui
