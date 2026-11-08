# ncmdump-js

从 `NcmdumpCSharp` 项目迁移的 NCM 解密实现。**核心是原生 JavaScript ES Modules，零第三方依赖、无 Node 依赖、无需打包。** 可直接导入浏览器、Web Worker，也能由 Node 调用。

已迁移：NCM 文件头解析、AES-128-ECB/PKCS#7、音频密钥盒、音频解密、MP3/FLAC 识别、元数据解析、封面提取。原 C# 的 `FixMetadata()` 使用 ATL 重写音频标签；本项目返回原始音频、元数据和封面三个独立结果，**不将标签和封面重新嵌入音频**。这不会改变解密后的音频内容。

## 快速使用

在线使用：[NCM 本地解密工具](https://royalangelcongress.github.io/ncmdump-js/)。文件只在浏览器内处理，不会上传。

```js
import { decryptNcm } from './src/index.js';

// file 是浏览器文件选择器返回的 File。
const result = decryptNcm(await file.arrayBuffer());
const audioBlob = new Blob([result.audio], { type: result.mimeType });
const url = URL.createObjectURL(audioBlob);
// 将 url 设为下载链接 href；下载名使用 result.format ?? 'bin'。
// 不再使用时调用 URL.revokeObjectURL(url)。
console.log(result.metadata, result.rawMetadata, result.cover);
```

打开浏览器示例（无需 `npm install`）：

```powershell
cd E:\workspace\ncmdump-js
npm run demo
```

访问 <http://127.0.0.1:8080>。使用其他端口：`$env:PORT=8081; npm run demo`。也可以用任何静态 HTTP 服务托管 `examples/` 和 `src/`；示例需要通过 HTTP/HTTPS 打开。解密在模块 Worker 中运行，避免大文件阻塞页面；文件不会上传，下载链接在选择下一文件或离开页面时释放。

示例和 `decryptNcm` 都会将完整输入、输出放在内存中，不是恒定内存的流式转换。更大的文件可使用下面的分块接口自行接入 Blob 切片、文件流或 Worker。

## GitHub Pages 部署

该项目可直接作为静态网站托管，无需后端、安装依赖或执行构建。当前使用 GitHub Pages 的 **Deploy from a branch**，发布源为 `main` 分支根目录 `/`。

- 根目录 `index.html` 使用相对路径进入 `examples/browser.html`。
- 页面、模块 Worker 与核心代码都使用相对路径，可在 `/ncmdump-js/` 项目子路径下运行。
- `.nojekyll` 让 Pages 按原样发布静态资源。
- 推送 `main` 后，GitHub 自动更新网站；部署进度可在仓库的 Actions 和 Settings → Pages 中查看。

克隆后部署到自己的仓库时，在 Settings → Pages 中选择同样的分支与目录即可。仓库中不要加入真实音乐文件；本项目的 `.gitignore` 已忽略 `.ncm`、`.mp3`、`.flac` 和本地 `.tmp/`。

## Node CLI（独立适配层）

Node 18+ 用于 CLI、开发服务和测试，浏览器核心不需要 Node。命令可以传入多个文件，默认将音频写到输入文件旁，输出文件已存在时拒绝覆盖。

```powershell
node bin/ncmdump.js "D:\music\song.ncm"
node bin/ncmdump.js "a.ncm" "b.ncm" -o "D:\output" --extract
node bin/ncmdump.js "a.ncm" -o "D:\output" --force
node bin/ncmdump.js "a.ncm" --recover-metadata
node bin/ncmdump.js --help
```

`--extract` 额外写出 `歌曲名.metadata.json`、`歌曲名.cover.png/jpg`。未知图片类型使用 `.cover.bin`。`--recover-metadata` 在元数据解码失败时继续解密音频并给出警告；文件结构、音频密钥或声明长度损坏时仍会报错。某个文件失败不影响后续文件，最终退出码为 1。CLI 目前接收文件列表，不包含原 C# 的目录递归扫描。

Node 代码调用同一核心：

```js
import { readFile, writeFile } from 'node:fs/promises';
import { decryptNcm } from './src/index.js';

const result = decryptNcm(await readFile('song.ncm'));
await writeFile(`song.${result.format ?? 'bin'}`, result.audio);
```

## API

`src/index.js` 是公开入口，同时提供 `src/index.d.ts`。输入支持 `ArrayBuffer`、`Uint8Array`、`DataView` 等 ArrayBuffer 视图，也兼容 Node 的 Buffer。视图的 `byteOffset` 和 `byteLength` 会被正确保留。核心不会修改输入。

### `decryptNcm(input, { strictMetadata = true } = {})`

同步解密完整容器，返回：

| 字段 | 含义 |
| --- | --- |
| `audio` | `Uint8Array`，解密后的原始音频 |
| `format` | `mp3` / `flac` / `null`；签名优先，其次使用受支持的元数据格式提示 |
| `mimeType` | `audio/mpeg` / `audio/flac` / `application/octet-stream` |
| `metadata` | 归一化的 `name/album/artist/artists/format/duration/bitrate`；无元数据时为 `null` |
| `rawMetadata` | 原始 JSON 对象，保留未映射的字段；无元数据时为 `null` |
| `cover` | 封面字节；没有封面时为空 `Uint8Array` |
| `coverMimeType` | `image/png` / `image/jpeg` / `null` |
| `audioOffset` | 音频在 NCM 输入中的字节起点 |
| `audioLength` | 当前输入中剩余的音频字节数 |
| `crc32` | 容器保存的 CRC 字段，仅提取，不校验 |
| `warnings` | 元数据恢复、格式提示冲突或未知格式等警告 |

`metadata.duration` 沿用 NCM 原始毫秒值。`metadata.format` 保留原值；确定输出格式请读取顶层 `format`。识别不出的内容不再默认标为 FLAC，CLI 保存为 `.bin`。

### `parseNcm(input, options)` / `decryptAudioChunk(chunk, offset = 0)`

解析容器头部及封面，返回上表中的头部信息（不包含 `audio/format/mimeType`），并提供无状态的分块解密方法。`offset` **相对于音频起点**，不是相对于 NCM 文件头；单位为字节。每次返回新的 `Uint8Array`，支持不规则分块、乱序调用和超过 32 位的偏移。

```js
import { parseNcm } from './src/index.js';

const bytes = new Uint8Array(await file.arrayBuffer());
const parsed = parseNcm(bytes);
const chunks = [];
const chunkSize = 64 * 1024;
for (let offset = 0; offset < parsed.audioLength; offset += chunkSize) {
  const start = parsed.audioOffset + offset;
  chunks.push(parsed.decryptAudioChunk(bytes.subarray(start, start + chunkSize), offset));
}
const blob = new Blob(chunks);
```

这段示例用于说明偏移，仍会读取整个文件。如果调用方自行分段读取，`parseNcm` 只需要收到完整的头部、元数据和封面区即可构造解密器；之后可按音频偏移从源文件读取分块，直接写往目标。此时 `audioLength` 仅代表传入片段中的音频长度，完整音频长度由调用方计算。

### 其他导出

- `detectAudioFormat(bytes)`：签名识别，包括 ID3、FLAC 和有效的 MPEG 音频帧头。
- `detectImageMimeType(bytes)`：PNG/JPEG 签名识别。
- `NcmError`：含 `code`、`message`、`offset`，偏移相对于输入 NCM 的起点。常见错误码：`ERR_INVALID_NCM`、`ERR_TRUNCATED`、`ERR_KEY`、`ERR_METADATA`、`ERR_COVER`、`ERR_EMPTY_AUDIO`。错误输入类型及非法分块偏移分别抛出 `TypeError`、`RangeError`。

## 结构与验证

```text
index.html           GitHub Pages 首页入口
.nojekyll            静态发布标记
src/                 可复制到浏览器项目的核心和类型声明
  aes.js             AES-128-ECB 和严格 PKCS#7 去填充
  bytes.js           二进制视图、ASCII、Base64
  ncm.js             NCM 解析、密钥盒、音频解密
  index.js           公开入口
  index.d.ts         TypeScript 类型
bin/ncmdump.js       Node 文件读写与 CLI
examples/            静态页面、模块 Worker
scripts/             本地示例服务器
test/                Node 内置测试，无测试框架依赖
docs/migration.md    原 C# 逻辑检查及迁移说明
```

运行 `npm test`。测试覆盖 NIST AES 标准向量、与 Node/OpenSSL 的随机密钥交叉校验、独立编码的完整 NCM 数据、Unicode 元数据、封面预留区、不规则分块、偏移边界、损坏和截断文件、CLI 与无 Node 全局对象的隔离环境。

自动测试中的完整容器使用独立编码器生成的合成夹具，音频载荷是带格式签名的测试字节。另已用 CLI 转换 14 个真实 NCM 文件，输出均经 ffprobe 识别为 MP3 并读取到时长；真实音乐文件未加入仓库。验证不覆盖所有 NCM 变体，也不对音频载荷作完整性认证。

AES 核心自行实现，因为标准 [Web Crypto 算法列表](https://www.w3.org/TR/webcrypto-1/#algorithm-overview) 没有 AES-ECB。实现参考 [FIPS 197](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.197-upd1.pdf)，测试采用 [NIST ECB 示例](https://csrc.nist.gov/csrc/media/projects/cryptographic-standards-and-guidelines/documents/examples/aes_ecb.pdf) 和 Node/OpenSSL 作为独立校验。

迁移来源：`NcmdumpCSharp` 项目的解密流程。保留原 MIT 许可证，见 [LICENSE.md](./LICENSE.md)。
