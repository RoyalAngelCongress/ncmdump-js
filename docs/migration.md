# C# 解密逻辑检查与 JS 迁移

来源为 `NcmdumpCSharp`。原项目保持不变，新实现放在独立的 `ncmdump-js` 项目中。

## 核心流程

原 `NeteaseCrypt.Initialize()` 的解密顺序是成立的。特别需要保留两点：封面帧长度与实际图片长度不是同一字段；音频使用的不是标准 RC4 PRGA。

| 阶段 | 原实现 | JS 实现 |
| --- | --- | --- |
| 魔数 | 两个 little-endian Int32，值为 `0x4e455443`、`0x4d414446` | 直接比较 ASCII `CTENFDAM` 的 8 字节，随后跳过 2 字节 |
| 音频密钥 | 长度 → XOR `0x64` → AES-128-ECB/PKCS#7 → 去前 17 字节 | 相同算法，并验证 `neteasecloudmusic` 前缀与非空密钥 |
| 元数据 | 长度 → XOR `0x63` → 跳过 22 字节 → Base64 → 另一密钥的 AES → 去 `music:` → JSON | 相同算法，验证前缀、UTF-8、Base64、PKCS#7 和 JSON 对象 |
| 图片区 | 跳过 CRC32 和图片版本 → 帧长度 → 图片长度 → 图片 → 剩余预留区 | 分别解析并检查 `imageLength <= coverFrameLength`，按整个帧推进 |
| 音频 | 初始化密钥盒，按音频相对位置产生 XOR 字节 | 保留同一公式，预先计算 256 字节周期掩码 |
| 输出 | FileStream / MemoryStream | Uint8Array，I/O 由外层决定 |

固定 AES 密钥分别为：

```text
音频密钥头：hzHRAmso5kInbaxW
元数据密钥：#14ljk_!\]&0U<'(
```

`BuildKeyBox` 是类似 RC4 KSA 的置换：

```text
S = [0, 1, ..., 255]
last = 0
for i = 0..255:
    c = (S[i] + last + key[i % key.length]) & 255
    swap(S[i], S[c])
    last = c
```

音频字节 `position` 对应的掩码为：

```text
j = (position + 1) & 255
mask = S[(S[j] + S[(S[j] + j) & 255]) & 255]
output[position] = input[position] XOR mask
```

这里的 `S` 在解密音频时不会继续交换，因此掩码以 256 字节为周期，允许预计算、随机访问和不规则分块。**不能直接用普通 RC4 库替代**。原 C# 的跨块 `position` 是正确的；JS 同样从第一个音频字节开始计数，而不是从整个容器起点计数。

## 原代码的问题及本次处理

1. **长度与截断检查不足。** `keyDataLength` 仅检查正数，元数据与图片长度来自有符号 Int32；负长度或 `coverFrameLength < imageLength` 会导致错误分配、负向 Seek 或错误边界。Seek 可以超出文件尾，无法据此判断数据完整性。JS 使用显式 little-endian Uint32，每次切片前检查剩余长度，非法封面关系直接报错。不会依据异常长度先分配巨型数组。

2. **密钥明文前缀未验证。** C# 直接去除前 17 字节，空密钥或短数据可能在构建密钥盒时越界。JS 验证前缀、AES 分组长度和完整 PKCS#7 填充后再构建密钥盒。

3. **输出格式可能错误。** `DetectFormat()` 只识别 ID3 和 FLAC，无法识别没有 ID3 的 MP3。`CreateOutputStreamForFirstChunk()` 检测失败后固定使用 `.flac`，即便元数据是 MP3。JS 新增 MPEG 音频帧头检查，按签名、受支持的元数据提示依次确定格式，仍未知则使用 `null` / `.bin`。

4. **含点文件名被二次改扩展名。** `PrepareDumpBasePath()` 先将 `artist.song.ncm` 变为 `artist.song`，`CreateOutputStreamForFirstChunk()` 再次 `Path.ChangeExtension`，最终得到 `artist.flac`。JS CLI 只去除输入的最后一个扩展名，然后追加输出扩展名，保留 `artist.song`。

5. **对象是一次性文件流。** 一次 Dump 后源流已经到文件尾，再次 Dump / DumpToStream 得不到音频。构造函数打开文件后若初始化抛错，调用方还拿不到对象来 Dispose，可能让文件句柄滞留到资源回收。JS 核心不持有文件句柄或隐式解密游标，可重复调用。

6. **读取辅助方法依赖单次 Read 填满。** `ReadBytes()` 仅调用一次 `Read`，不足指定长度即报错。对于可短读的数据源，应循环读取或用 `ReadExactly`。JS 从已提供的字节片段解析，不把短读当作完整字段；流适配器需自行先收集完整头部。

7. **CLI 的单独文件忽略 `-o`。** `CollectFiles()` 给位置参数文件的 `relativeToBase` 设为 null，而 `ProcessFiles()` 只在该值非 null 时赋 `targetOutputDir`。新 CLI 直接对每个文件应用输出目录；也拒绝默认覆盖，失败时设置非零退出码。原 CLI 对处理错误通常仍返回 0。

8. **与解密分离的标签步骤。** `FixMetadata()` 依赖 ATL，并且元数据为 null 时连单独存在的封面也不会写入。JS 保留音频原始字节，单独返回规范化元数据、完整 JSON 和图片。标签嵌入需要额外的 ID3/FLAC 标签写入层，当前没有实现。

9. **运行目标说明不一致。** 原 README 写 .NET 8+，实际项目目标是 `net10.0`。本机可用 SDK 为 7.0.400，因此本次没有直接编译运行原 C# 项目，也没有安装或修改 .NET 环境。

## 行为边界

- 原 C# 的 `FromJson()` 会吞掉 JSON 或字段类型错误并返回 null；JS 默认严格报告元数据错误，可显式选择 `strictMetadata: false` 恢复音频。可选字段类型不符时使用默认值，保留原始 JSON。
- 图片类型根据 PNG/JPEG 魔数识别，未知类型返回 null，不再将所有非 PNG 图片都视为 JPEG。
- 和原实现一样，不校验保存的 CRC 字段，也不验证解密后音频的完整编解码结构。合法头部不代表音频未损坏。
- `decryptNcm` 是整文件内存 API。分块算法已经提供，但没有实现自动解析异步输入流、磁盘目录递归或音频标签写入。
- 原 C# 工程未改动。原许可证已复制到新项目。

## 验证方法

- AES 使用 FIPS 197 单块向量、NIST SP 800-38A 多块向量，以及不同长度的随机明文与 Node/OpenSSL 加密结果交叉验证。
- 完整 NCM 夹具由测试中的独立编码器构造，AES 来自 Node/OpenSSL，密钥盒/XOR 使用原 C# 算法的直接转写。预期音频是在编码前独立保存的明文，不由被测解密器产生。
- 覆盖 Unicode JSON、缺失元数据、PNG 封面及预留区、MP3/FLAC、格式冲突、Buffer/DataView 偏移、不规则分块、超过 32 位的偏移、每一个头部截断位置、异常长度、PKCS#7 与损坏元数据恢复。
- 将真实 `src/` 模块图加载到隔离 JS 上下文，只注入标准 `TextDecoder`；上下文中没有 `process`、`Buffer`、`require`、`crypto`、`atob`，并验证完整转换结果。
- CLI 验证输出目录、侧文件提取、含点文件名、覆盖保护、失败退出码和多文件失败后继续处理。
- 最终 38 项自动测试通过。浏览器实测通过模块 Worker 解密合成 NCM，显示 70,007 字节音频、中文歌曲信息和封面下载链接；同时验证了损坏元数据的默认报错和显式恢复。示例服务器验证了入口重定向与模块路径，浏览器还验证了同一文件重新选择的流程。
- 后续已用 CLI 转换 14 个真实 NCM 文件，输出均经 ffprobe 识别为 MP3 并读取到时长。真实音乐文件未加入仓库；自动测试继续使用合成夹具，兼容性结论不覆盖所有 NCM 变体。

标准资料：[NIST FIPS 197](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.197-upd1.pdf)、[NIST ECB 示例](https://csrc.nist.gov/csrc/media/projects/cryptographic-standards-and-guidelines/documents/examples/aes_ecb.pdf)、[Web Crypto 算法列表](https://www.w3.org/TR/webcrypto-1/#algorithm-overview)。
