常规原生安装包：Windows x64/ARM64 MSI；Linux x64/ARM64 DEB/RPM；macOS Apple Silicon PKG。

不再使用旧自绘安装向导。包内包含 Node 与应用，安装后通过系统应用入口打开浏览器界面；支持正常停止、实例复用和独立数据目录，卸载默认保留配置、数据库与附件。服务器部署与旧版数据迁移、签名状态和构建验证见 tools/installer/README.md。

WebGUI 使用当前源码构建，安装器改动不替换其页面实现。历史 x86 部署器不代表支持 32 位 Node 应用；本次没有 32 位完整安装包。
