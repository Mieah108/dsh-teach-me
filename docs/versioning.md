# 版本与发布

`package.json` 是版本号的唯一来源，`CHANGELOG.md` 的首个版本段应与之保持一致。GitHub 标签取 `<version>-public`（或 `v<version>`），其中 `<version>` 必须等于 `package.json`，例如 `0.7.4-public` 对应 `dsh-teach-me@0.7.4`。`-public` 只是 GitHub 标签后缀，不改变 npm 版本号：版本本身是否为预发布决定 npm 的 dist-tag，预发布版本（如 `0.8.0-beta.1`）发到 `next`，稳定版本发到 `latest`。

## 交付内容

| 交付物 | 内容 |
| --- | --- |
| npm 运行包 `.tgz` | 插件、客户端、预设、提示词、技能、课程资源、维护 CLI、文档与许可 |
| 源码归档 `.tar.gz` | 运行内容，以及构建输入、锁文件、测试、维护脚本与工作流 |
| `release-manifest.json` | 包名、版本、文件清单与逐文件 SHA-256 |
| `SHA256SUMS` | 发行附件的 SHA-256 |

运行包不包含开发依赖和测试工具。源码归档不包含 `.git`、已安装依赖、本地配置、学习档案或临时产物。具体布局见 [文件清单](../INVENTORY.md)。

## 本地演练

在源码根目录运行，输出目录应在仓库外且为空：

```bash
pnpm install --frozen-lockfile
pnpm verify:source
node scripts/export-release.mjs --output /path/to/release-output
node scripts/release-notes.mjs --tag 0.8.0-beta.1-public --output /path/to/release-notes.md
node scripts/publish-npm.mjs --directory /path/to/release-output --dry-run
```

导出器核对实际归档、入口、资源、许可、哈希和包内链接。`publish-npm.mjs` 默认只演练；只有显式传入 `--publish` 才会发布。它只使用导出器生成并重新校验过的运行包，默认带 `--provenance`；从私有仓库发布时 npm 无法生成 provenance 声明，需要加 `--no-provenance`，否则发布会被拒绝。

首个版本的发布说明保存在 [0.7.4-public](releases/0.7.4-public.md)。后续版本可提供 `docs/releases/<tag>.md`；没有独立说明时，从 CHANGELOG 的当前版本段生成说明并附安装命令。

除自动检查外，宿主安装、侧栏课堂、媒体与动画需要按 [测试说明](testing.md) 验收。

## 按版本提交自动发布 npm

推送到 `main` 时，`release.yml` 比较推送前后的 `package.json`。版本号升高才进入发布流程，一次推送以最终提交的版本为准。普通提交和 PR 继续由 `ci.yml` 检查。首次启用或补发当前版本时，在 Actions 的 **Release → Run workflow** 选择 `main`，将 `tag` 留空。

发布作业使用锁定依赖执行源码校验，生成并核验运行包，演练通过后才发布。预发布进 `next`，正式版进 `latest`。两个入口共用发布队列；npm 已有同版本时，仅当 SHA-512 一致才跳过。两个 dist-tag 都会拒绝指回更旧的版本。

公有和私有 GitHub 仓库都可以从 `main` 发布 npm。公有仓库生成 provenance，私有仓库使用 `--no-provenance`。自动发布只上传 npm 运行包。公有仓库如需附源码归档、运行包和哈希，可另推 `v<version>` 或 `<version>-public` 标签，或在 **Run workflow** 指定现有标签。标签必须指向对应版本的提交；同一版本如已自动发布，应给当时发布的提交打标签。

## npm Trusted Publishing

在 npm 包 `dsh-teach-me` 的 Settings → Trusted publishing 中为 GitHub Actions 建立连接：

| 字段 | 值 |
| --- | --- |
| Organization or user | `Mieah108` |
| Repository | `dsh-teach-me` |
| Workflow filename | `release.yml` |
| Environment name | 留空 |
| Allowed actions | 允许 `npm publish` |

新连接应在两天内完成首次成功发布。工作流在 GitHub 托管运行器上使用 OIDC。已有 `NPM_TOKEN` Secret 的项目也可将其作为首次发布的备用凭据。新包尚无 npm 设置页时，先用已获授权的 npm 账户手动发布首版，或者配置备用 Secret。包名、仓库地址和权限需与实际发布目标一致。

本地补发使用前文已核验的发行归档，将 `--dry-run` 换成 `--publish`。源仓库是私有仓库或本地没有 provenance 所需的 CI 身份时，加 `--no-provenance`。本地提交和打标签不会触发 Actions，推送版本提交或手动启动工作流后才会发布。

参考：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[GitHub Actions 发布 Node.js 包](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages)。

## 升级与回滚

升级前备份教学模式设置与学习工作区，再安装明确版本并重启 DeepSeek Harness。使用 `link:` 安装时，安装目录需要保留在原位；从旧本地包迁移时先移除 `@local/dsh-teach-me`。

回滚时重新安装明确版本的代码。保留已有学习档案，避免用旧备份覆盖新作答；旧代码无法识别日志事件或课程块时，应使用兼容版本。

`index.json` 和 `snapshot.json` 是可重建的派生数据，完整日志才是恢复学习档案的依据。修复日志前应先备份。
