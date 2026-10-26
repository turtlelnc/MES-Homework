#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assemble, copyTree } from "./assemble.mjs";
import { packageVersions } from "./versions.mjs";
import { minimumMacOS } from "./macho.mjs";

const root = path.resolve(import.meta.dirname, "../.."),
  args = process.argv.slice(2);
const option = (name, fallback = "") => {
  const i = args.indexOf("--" + name);
  return i < 0 ? fallback : args[i + 1];
};
const output = path.resolve(option("out", "release-native"));
const versions = packageVersions(),
  work = fs.mkdtempSync(path.join(os.tmpdir(), "mes-native-"));
const payload = path.join(work, "payload");
const xml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const shell = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const id = (prefix, value) =>
  prefix + createHash("sha256").update(value).digest("hex").slice(0, 30);
function guid(value) {
  const h = createHash("sha256")
    .update("MESHomework/native/" + value)
    .digest("hex")
    .slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}
const run = (program, argv, opts = {}) =>
  execFileSync(program, argv, { stdio: "inherit", ...opts });
const put = (file, content, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
};
const artifact = (extension) =>
  path.join(
    output,
    `mes-homework-${versions.version}-${{ win32: "windows", linux: "linux", darwin: "macos" }[process.platform]}-${process.arch}.${extension}`,
  );
const enumerate = (folder) =>
  fs
    .readdirSync(folder, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? enumerate(path.join(folder, e.name))
        : [path.join(folder, e.name)],
    );
function normalizeModes(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) normalizeModes(file);
    else fs.chmodSync(file, fs.statSync(file).mode & 0o111 ? 0o755 : 0o644);
  }
  fs.chmodSync(folder, 0o755);
}
async function record(file, format, metadata) {
  const hash = createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  const info = {
    ...metadata,
    format,
    asset: path.basename(file),
    size: fs.statSync(file).size,
    sha256: hash.digest("hex"),
  };
  put(file + ".meta.json", JSON.stringify(info, null, 2) + "\n");
  console.log(`artifact: ${info.asset} (${info.size} bytes)`);
}
function launcher(rootDir) {
  fs.mkdirSync(path.join(rootDir, "bin"), { recursive: true });
  put(
    path.join(rootDir, "bin/mes-homework"),
    `#!/bin/sh\nset -eu\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$HERE/runtime/node" "$HERE/app/tools/installer/runtime/launch.mjs" "$@"\n`,
    0o755,
  );
}
function windows() {
  const exe = path.resolve(option("launcher"));
  if (!option("launcher") || !fs.existsSync(exe))
    throw new Error("Build the native Windows launcher and supply --launcher");
  const pe = fs.readFileSync(exe);
  const peOffset = pe.readUInt32LE(0x3c);
  if (
    pe.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0" ||
    pe.readUInt16LE(peOffset + 4) !==
      (process.arch === "arm64" ? 0xaa64 : 0x8664)
  )
    throw new Error(
      "Launcher PE architecture does not match the bundled Node runtime",
    );
  fs.copyFileSync(exe, path.join(payload, "MESHomework.exe"));
  const components = [];
  function directory(folder) {
    return fs
      .readdirSync(folder, { withFileTypes: true })
      .map((e) => {
        const absolute = path.join(folder, e.name),
          rel = path.relative(payload, absolute).replaceAll("\\", "/");
        if (e.isDirectory())
          return `<Directory Id="${id("D", rel)}" Name="${xml(e.name)}">${directory(absolute)}</Directory>`;
        if (!e.isFile()) throw new Error("Unexpected payload entry");
        const component = id("C", rel),
          file = id("F", rel);
        components.push(component);
        return `<Component Id="${component}" Guid="${guid(process.arch + "/" + rel)}"><File Id="${file}" Source="${xml(absolute)}" Name="${xml(e.name)}" KeyPath="yes" /></Component>`;
      })
      .join("\n");
  }
  const tree = directory(payload);
  const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
  const rtf =
    "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Segoe UI;}}\\f0\\fs20 " +
    license
      .replaceAll("\\", "\\\\")
      .replaceAll("{", "\\{")
      .replaceAll("}", "\\}")
      .replaceAll("\n", "\\par\n") +
    "}";
  put(path.join(work, "license.rtf"), rtf);
  const wxs = `<?xml version="1.0" encoding="UTF-8"?>
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui" xmlns:util="http://wixtoolset.org/schemas/v4/wxs/util">
<Package Name="MES Homework" Manufacturer="MES Homework" Version="${versions.native}" Language="2052" Codepage="936" UpgradeCode="${guid("windows-upgrade")}" Scope="perMachine">
  <SummaryInformation Description="MES Homework ${versions.version} build ${versions.build}" />
  <MajorUpgrade DowngradeErrorMessage="A newer MES Homework version is already installed." AllowSameVersionUpgrades="yes" Schedule="afterInstallInitialize" />
  <MediaTemplate EmbedCab="yes" />
  <Property Id="OSBUILD"><RegistrySearch Id="ReadOsBuild" Root="HKLM" Key="SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" Name="CurrentBuildNumber" Type="raw" /></Property>
  <Launch Condition="Installed OR OSBUILD &gt;= 10240" Message="MES Homework requires Windows 10 / Server 2016 or later (Node 24 requirement)." />
  <Property Id="ARPNOMODIFY" Value="1" /><Property Id="ARPURLINFOABOUT" Value="https://github.com/turtlelnc/MES-Homework" />
  <StandardDirectory Id="ProgramFiles64Folder"><Directory Id="INSTALLFOLDER" Name="MES Homework">${tree}</Directory></StandardDirectory>
  <StandardDirectory Id="ProgramMenuFolder"><Directory Id="MENUDIR" Name="MES Homework"><Component Id="Shortcuts" Guid="${guid("shortcuts-" + process.arch)}">
    <Shortcut Id="StartApp" Name="MES Homework" Target="[INSTALLFOLDER]MESHomework.exe" WorkingDirectory="INSTALLFOLDER" />
    <Shortcut Id="StopApp" Name="Stop MES Homework" Target="[INSTALLFOLDER]MESHomework.exe" Arguments="--stop" WorkingDirectory="INSTALLFOLDER" />
    <RemoveFolder Id="RemoveMenu" On="uninstall" /><RegistryValue Root="HKLM" Key="Software\\MESHomework" Name="Installed" Type="integer" Value="1" KeyPath="yes" />
  </Component></Directory></StandardDirectory>
  <StandardDirectory Id="CommonAppDataFolder"><Directory Id="SERVERDATA" Name="MESHomework"><Component Id="ServerDataPermissions" Guid="${guid("server-data")}" Permanent="yes">
    <CreateFolder><PermissionEx Id="ServerDataAcl" Sddl="O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIIO;FA;;;LS)(A;;0x1201bf;;;LS)" /></CreateFolder>
  </Component></Directory></StandardDirectory>
  <DirectoryRef Id="INSTALLFOLDER"><Component Id="ServerService" Guid="${guid("service-" + process.arch)}">
    <File Id="ServiceMarker" Source="${xml(path.join(work, "service-mode.txt"))}" Name="service-mode.txt" KeyPath="yes" />
    <ServiceInstall Id="InstallService" Name="MESHomework" DisplayName="MES Homework" Description="MES Homework server (loopback by default; configure HTTPS before public access)" Type="ownProcess" Start="auto" ErrorControl="normal" Account="NT AUTHORITY\\LocalService" Arguments="--service">
      <util:ServiceConfig FirstFailureActionType="restart" SecondFailureActionType="restart" ThirdFailureActionType="restart" RestartServiceDelayInSeconds="5" ResetPeriodInDays="1" />
    </ServiceInstall>
    <ServiceControl Id="ControlService" Name="MESHomework" Start="install" Stop="both" Remove="uninstall" Wait="yes" />
  </Component></DirectoryRef>
  <Feature Id="Application" Title="MES Homework" Description="Application files and Start menu shortcuts. User data is kept when uninstalling." Level="1" AllowAbsent="no" Display="expand" ConfigurableDirectory="INSTALLFOLDER">
    ${components.map((c) => `<ComponentRef Id="${c}"/>`).join("")}
    <ComponentRef Id="Shortcuts" />
    <Feature Id="Server" Title="Windows server service (optional)" Description="Run automatically as LocalService using separate ProgramData. Disabled by default; select only for server hosting." Level="2"><ComponentRef Id="ServerDataPermissions"/><ComponentRef Id="ServerService"/></Feature>
  </Feature>
  <ui:WixUI Id="WixUI_FeatureTree" /><WixVariable Id="WixUILicenseRtf" Value="${xml(path.join(work, "license.rtf"))}" />
</Package></Wix>`;
  // A Windows service component's key path must be its executable. The service
  // command targets the already-installed launcher through a dedicated copy.
  const serviceExe = path.join(payload, "MESHomeworkService.exe");
  fs.copyFileSync(exe, serviceExe);
  const corrected = wxs.replace(
    `Source="${xml(path.join(work, "service-mode.txt"))}" Name="service-mode.txt"`,
    `Source="${xml(serviceExe)}" Name="MESHomeworkService.exe"`,
  );
  put(path.join(work, "installer.wxs"), corrected);
  const file = artifact("msi");
  run(option("wix", "wix"), [
    "build",
    path.join(work, "installer.wxs"),
    "-arch",
    process.arch === "arm64" ? "arm64" : "x64",
    "-ext",
    "WixToolset.UI.wixext/5.0.2",
    "-ext",
    "WixToolset.Util.wixext/5.0.2",
    "-culture",
    "zh-CN",
    "-o",
    file,
  ]);
  return [[file, "msi"]];
}
function linux() {
  launcher(payload);
  const stage = path.join(work, "deb"),
    appDir = path.join(stage, "opt/mes-homework");
  copyTree(payload, appDir);
  const service = fs.readFileSync(
    path.join(root, "tools/installer/linux/mes-homework.service"),
    "utf8",
  );
  put(path.join(stage, "usr/lib/systemd/system/mes-homework.service"), service);
  put(
    path.join(stage, "usr/share/applications/mes-homework.desktop"),
    `[Desktop Entry]\nType=Application\nName=MES Homework\nComment=Homework analysis\nExec=/opt/mes-homework/bin/mes-homework\nTerminal=false\nCategories=Education;\n`,
  );
  put(
    path.join(stage, "usr/share/applications/mes-homework-stop.desktop"),
    `[Desktop Entry]\nType=Application\nName=Stop MES Homework\nExec=/opt/mes-homework/bin/mes-homework --stop\nTerminal=false\nCategories=Education;\n`,
  );
  put(
    path.join(stage, "usr/share/doc/mes-homework/copyright"),
    fs.readFileSync(path.join(root, "LICENSE"), "utf8"),
  );
  put(
    path.join(work, "debian/control"),
    "Source: mes-homework\nSection: education\nPriority: optional\nMaintainer: MES Homework <noreply@users.noreply.github.com>\n\nPackage: mes-homework\nArchitecture: any\nDescription: MES Homework\n",
  );
  const elfFiles = enumerate(appDir).filter((f) => {
    const fd = fs.openSync(f, "r");
    try {
      const b = Buffer.alloc(4);
      return (
        fs.readSync(fd, b, 0, 4, 0) === 4 &&
        b.equals(Buffer.from([127, 69, 76, 70]))
      );
    } finally {
      fs.closeSync(fd);
    }
  });
  const dependencyOutput = execFileSync(
    "dpkg-shlibdeps",
    ["-O", ...elfFiles.map((f) => "-e" + f)],
    { cwd: work, encoding: "utf8" },
  );
  const dependencies = dependencyOutput.match(/^shlibs:Depends=(.+)$/m)?.[1];
  if (!dependencies)
    throw new Error(
      "Cannot derive native dependencies from assembled ELF files",
    );
  const size = Math.ceil(
    enumerate(stage).reduce((n, f) => n + fs.statSync(f).size, 0) / 1024,
  );
  put(
    path.join(stage, "DEBIAN/control"),
    `Package: mes-homework\nVersion: ${versions.deb}\nArchitecture: ${process.arch === "arm64" ? "arm64" : "amd64"}\nMaintainer: MES Homework <noreply@users.noreply.github.com>\nSection: education\nPriority: optional\nInstalled-Size: ${size}\nDepends: ${dependencies}, adduser\nRecommends: xdg-utils\nHomepage: https://github.com/turtlelnc/MES-Homework\nDescription: MES Homework\n Bundled Node runtime and browser application. Data survives removal.\n`,
  );
  const stop = fs.readFileSync(
    path.join(root, "tools/installer/linux/stop-for-upgrade.sh"),
    "utf8",
  );
  const configure = fs.readFileSync(
    path.join(root, "tools/installer/linux/configure.sh"),
    "utf8",
  );
  const remove = fs.readFileSync(
    path.join(root, "tools/installer/linux/remove.sh"),
    "utf8",
  );
  put(path.join(stage, "DEBIAN/preinst"), stop, 0o755);
  put(path.join(stage, "DEBIAN/postinst"), configure, 0o755);
  put(
    path.join(stage, "DEBIAN/prerm"),
    `#!/bin/sh\nset -eu\ncase "\${1:-}" in upgrade)\n${stop.split("\n").slice(2).join("\n")}\n;; *)\n${remove.split("\n").slice(2).join("\n")}\n;; esac\n`,
    0o755,
  );
  put(
    path.join(stage, "DEBIAN/postrm"),
    `#!/bin/sh\nif command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1 || true; fi\n# Never remove user data or APP_SECRET.\n`,
    0o755,
  );
  normalizeModes(stage);
  const deb = artifact("deb");
  run("dpkg-deb", ["--root-owner-group", "--build", stage, deb]);
  if (args.includes("--deb-only")) return [[deb, "deb"]];
  const rpmRoot = path.join(work, "rpm");
  for (const name of [
    "BUILD",
    "BUILDROOT",
    "RPMS",
    "SOURCES",
    "SPECS",
    "SRPMS",
  ])
    fs.mkdirSync(path.join(rpmRoot, name), { recursive: true });
  fs.rmSync(path.join(stage, "DEBIAN"), { recursive: true });
  const spec = `Name: mes-homework\nVersion: ${versions.rpmVersion}\nRelease: ${versions.rpmRelease}\nSummary: MES Homework\nLicense: MIT\nURL: https://github.com/turtlelnc/MES-Homework\nBuildArch: ${process.arch === "arm64" ? "aarch64" : "x86_64"}\nRequires: shadow-utils\nRecommends: xdg-utils\n%global __os_install_post %{nil}\n%description\nBundled Node runtime and browser application. Data survives removal.\n%prep\n%build\n%install\nmkdir -p "%{buildroot}"\ncp -a ${shell(stage)}/. "%{buildroot}/"\n%pre\n${stop}\n%post\nexport MES_PACKAGE_FORMAT=rpm\n${configure}\n%preun\nif [ "$1" = 0 ]; then\n${remove.replaceAll('"\${1:-}"', '"remove"')}\nfi\n%postun\nif command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1 || true; fi\n%files\n/opt/mes-homework\n/usr/lib/systemd/system/mes-homework.service\n/usr/share/applications/mes-homework*.desktop\n/usr/share/doc/mes-homework\n`;
  put(path.join(rpmRoot, "SPECS/app.spec"), spec);
  run("rpmbuild", [
    "--define",
    `_topdir ${rpmRoot}`,
    "--define",
    "_build_id_links none",
    "-bb",
    path.join(rpmRoot, "SPECS/app.spec"),
  ]);
  const built = enumerate(path.join(rpmRoot, "RPMS")).find((f) =>
    f.endsWith(".rpm"),
  );
  if (!built) throw new Error("RPM builder did not produce a package");
  const rpm = artifact("rpm");
  fs.copyFileSync(built, rpm);
  return [
    [deb, "deb"],
    [rpm, "rpm"],
  ];
}
function macos() {
  const stage = path.join(work, "mac"),
    bundle = path.join(stage, "Applications/MES Homework.app"),
    resources = path.join(bundle, "Contents/Resources");
  copyTree(payload, resources);
  put(
    path.join(bundle, "Contents/MacOS/MESHomework"),
    `#!/bin/sh\nset -eu\nHERE="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)"\nexec "$HERE/runtime/node" "$HERE/app/tools/installer/runtime/launch.mjs" "$@"\n`,
    0o755,
  );
  put(
    path.join(bundle, "Contents/Info.plist"),
    `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.mes-homework.app</string><key>CFBundleName</key><string>MES Homework</string><key>CFBundleExecutable</key><string>MESHomework</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${versions.short}</string><key>CFBundleVersion</key><string>${versions.native}</string><key>LSUIElement</key><true/><key>LSArchitecturePriority</key><array><string>arm64</string></array></dict></plist>`,
  );
  const component = path.join(work, "components.plist");
  put(
    component,
    `<?xml version="1.0"?><plist version="1.0"><array><dict><key>RootRelativeBundlePath</key><string>Applications/MES Homework.app</string><key>BundleIsRelocatable</key><false/><key>BundleHasStrictIdentifier</key><true/><key>BundleOverwriteAction</key><string>upgrade</string></dict></array></plist>`,
  );
  normalizeModes(stage);
  const machoFiles = [
    path.join(resources, "runtime/node"),
    ...enumerate(path.join(resources, "app/node_modules")).filter((f) =>
      f.endsWith(".node"),
    ),
  ];
  const minimum = minimumMacOS(
    machoFiles.map((file) =>
      execFileSync("otool", ["-l", file], { encoding: "utf8" }),
    ),
  );
  const componentPackage = path.join(work, "application.pkg");
  run("pkgbuild", [
    "--root",
    stage,
    "--component-plist",
    component,
    "--identifier",
    "org.mes-homework.installer",
    "--version",
    versions.native,
    "--install-location",
    "/",
    componentPackage,
  ]);
  put(
    path.join(work, "resources/license.txt"),
    fs.readFileSync(path.join(root, "LICENSE"), "utf8"),
  );
  put(
    path.join(work, "distribution.xml"),
    `<?xml version="1.0"?><installer-gui-script minSpecVersion="2"><title>MES Homework</title><license file="license.txt"/><options customize="never" require-scripts="false" hostArchitectures="arm64"/><domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/><volume-check><allowed-os-versions><os-version min="${minimum}"/></allowed-os-versions></volume-check><choices-outline><line choice="application"/></choices-outline><choice id="application" title="MES Homework" visible="false"><pkg-ref id="org.mes-homework.installer"/></choice><pkg-ref id="org.mes-homework.installer" version="${versions.native}" onConclusion="none">application.pkg</pkg-ref></installer-gui-script>`,
  );
  const file = artifact("pkg");
  run("productbuild", [
    "--distribution",
    path.join(work, "distribution.xml"),
    "--resources",
    path.join(work, "resources"),
    "--package-path",
    work,
    file,
  ]);
  console.log(`macOS minimum derived from Mach-O metadata: ${minimum}`);
  return [[file, "pkg"]];
}
try {
  fs.mkdirSync(output, { recursive: true });
  const metadata = await assemble(root, payload, {
    modules: path.resolve(option("modules", path.join(root, "node_modules"))),
  });
  let files;
  if (process.platform === "win32") files = windows();
  else if (process.platform === "linux") files = linux();
  else files = macos();
  for (const [file, format] of files) await record(file, format, metadata);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
