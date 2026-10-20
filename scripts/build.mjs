#!/usr/bin/env node
// 构建：生成种子 → 写 bundle patch（cordis.patch.yml，内嵌助理提示词）→ npm pack → 拼出给别的电脑用的安装包 dist/dsh-meeting-kit-<ver>.zip
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], ...opts }).toString().trim();

// 种子来自原 MAS 仓库的两个 demo（../../hub、../../outing）；单独拿到本仓库时没有它们，就用已提交的 lib/seeds.json
if (fs.existsSync(path.join(ROOT, "..", "hub", "data.mjs"))) run(process.execPath, ["scripts/gen-seeds.mjs"]);
else console.log("skip gen-seeds（没有 ../hub/data.mjs），用现有 lib/seeds.json");
const { bundlePatch } = await import(path.join(ROOT, "lib", "patch.mjs"));
const patch = bundlePatch();
fs.writeFileSync(path.join(ROOT, "cordis.patch.yml"), patch);
console.log("wrote cordis.patch.yml");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const dist = path.join(ROOT, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
// 把运行时依赖（@amaster.ai/dsh-a2a 及其依赖、bonjour-service、schemastery）打进 tgz（bundleDependencies），
// 另一台电脑安装时不用再从 npm 下载这些包。dsh 自己的包（cordis、dsh-agent 等）由那台电脑的 dsh 安装提供。
const stage = path.join(dist, ".stage");
fs.mkdirSync(stage, { recursive: true });
for (const f of pkg.files) fs.cpSync(path.join(ROOT, f), path.join(stage, f), { recursive: true });
const staged = { ...pkg, bundleDependencies: Object.keys(pkg.dependencies) };
delete staged.scripts;
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(staged, null, 2) + "\n");
fs.writeFileSync(path.join(stage, "pnpm-workspace.yaml"), "nodeLinker: hoisted\nautoInstallPeers: false\n");
run("pnpm", ["install", "--prod", "--prefer-offline", "--ignore-scripts", "--no-lockfile"], { cwd: stage, stdio: ["ignore", "pipe", "inherit"] });
fs.rmSync(path.join(stage, "pnpm-workspace.yaml"));
const tgz = run("npm", ["pack", "--silent", "--pack-destination", dist], { cwd: stage }).split("\n").pop();
fs.rmSync(stage, { recursive: true, force: true });
fs.copyFileSync(path.join(dist, tgz), path.join(dist, "dsh-meeting.tgz")); // GitHub Release 用的固定文件名（releases/latest/download/dsh-meeting.tgz）
console.log("packed", tgz);

// 安装包：tgz + 安装 / 启动脚本 + 说明
const kitName = `dsh-meeting-kit-${pkg.version}`;
const kit = path.join(dist, kitName);
fs.mkdirSync(kit);
fs.copyFileSync(path.join(dist, tgz), path.join(kit, tgz));
for (const f of fs.readdirSync(path.join(ROOT, "kit"))) {
  let txt = fs.readFileSync(path.join(ROOT, "kit", f), "utf8").replaceAll("__TGZ__", tgz).replaceAll("__VERSION__", pkg.version);
  fs.writeFileSync(path.join(kit, f), txt, { mode: f.endsWith(".sh") ? 0o755 : 0o644 });
}
fs.copyFileSync(path.join(ROOT, "README.md"), path.join(kit, "README.md"));
run("zip", ["-qr", `${kitName}.zip`, kitName], { cwd: dist });
console.log("kit:", path.join(dist, `${kitName}.zip`));
