const fileInput = document.querySelector('#file');
const recoverInput = document.querySelector('#recover');
const status = document.querySelector('#status');
const downloads = document.querySelector('#downloads');
const cover = document.querySelector('#cover');
const metadata = document.querySelector('#metadata');
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const urls = [];

function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
}

function addDownload(blob, name, text) {
  const link = document.createElement('a');
  link.href = objectUrl(blob);
  link.download = name;
  link.textContent = text;
  downloads.append(link);
}

function convert(buffer) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error.message)) : resolve(data.result);
    worker.onerror = (event) => reject(new Error(event.message || '解密 Worker 加载失败'));
    worker.postMessage({ buffer, recoverMetadata: recoverInput.checked }, [buffer]);
  });
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  downloads.replaceChildren();
  cover.replaceChildren();
  metadata.hidden = true;
  fileInput.disabled = true;
  recoverInput.disabled = true;
  status.textContent = `正在处理 ${file.name}…`;
  try {
    const result = await convert(await file.arrayBuffer());
    const stem = file.name.replace(/\.ncm$/i, '');
    addDownload(new Blob([result.audio], { type: result.mimeType }), `${stem}.${result.format ?? 'bin'}`, '下载音频');
    const json = JSON.stringify({ metadata: result.metadata, rawMetadata: result.rawMetadata, warnings: result.warnings }, null, 2);
    addDownload(new Blob([json], { type: 'application/json' }), `${stem}.metadata.json`, '下载歌曲信息');
    metadata.textContent = json;
    metadata.hidden = false;
    if (result.cover.length) {
      const blob = new Blob([result.cover], { type: result.coverMimeType ?? 'application/octet-stream' });
      const extension = result.coverMimeType === 'image/png' ? 'png' : result.coverMimeType === 'image/jpeg' ? 'jpg' : 'bin';
      addDownload(blob, `${stem}.cover.${extension}`, '下载封面');
      if (result.coverMimeType) {
        const image = document.createElement('img');
        image.src = objectUrl(blob);
        image.alt = '专辑封面';
        cover.append(image);
      }
    }
    status.textContent = `完成：${result.format ?? '未知格式'}，${result.audio.length.toLocaleString()} 字节。`
      + (result.warnings.length ? `\n${result.warnings.join('\n')}` : '');
  } catch (error) {
    status.textContent = `解密失败：${error.message}`;
  } finally {
    // Permit selecting the same file again after toggling metadata recovery.
    fileInput.value = '';
    fileInput.disabled = false;
    recoverInput.disabled = false;
  }
});

window.addEventListener('pagehide', () => {
  for (const url of urls) URL.revokeObjectURL(url);
  worker.terminate();
});
