#!/usr/bin/env node
// Node-only I/O adapter. The src/ core has no Node dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { decryptNcm } from '../src/index.js';

const usage = `Usage: ncmdump-js [--output DIR] [--extract] [--force] [--recover-metadata] FILE.ncm ...

  -o, --output DIR      Output directory (default: beside each input)
  --extract            Also save metadata JSON and cover image
  --force              Allow overwriting existing output files
  --recover-metadata   Recover audio even if metadata is damaged
  -h, --help           Show help

Audio bytes are decrypted as-is; tags and cover are not embedded into the audio.`;

function parseArguments(args) {
  const result = { files: [], output: null, extract: false, force: false, strictMetadata: true };
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positional) result.files.push(arg);
    else if (arg === '--') positional = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--output' || arg === '-o') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(`${arg} requires a directory`);
      result.output = args[++i];
    } else if (arg === '--extract') result.extract = true;
    else if (arg === '--force') result.force = true;
    else if (arg === '--recover-metadata') result.strictMetadata = false;
    else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else result.files.push(arg);
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (!options.files.length) throw new Error(usage);
  for (const file of options.files) {
    try {
      const source = resolve(file);
      if (extname(source).toLowerCase() !== '.ncm') throw new Error('Input must have a .ncm extension');
      const result = decryptNcm(await readFile(source), { strictMetadata: options.strictMetadata });
      const directory = options.output ? resolve(options.output) : dirname(source);
      const stem = basename(source, extname(source));
      await mkdir(directory, { recursive: true });
      const destination = join(directory, `${stem}.${result.format ?? 'bin'}`);
      const writeOptions = { flag: options.force ? 'w' : 'wx' };
      await writeFile(destination, result.audio, writeOptions);
      if (options.extract) {
        await writeFile(join(directory, `${stem}.metadata.json`), JSON.stringify({
          metadata: result.metadata,
          rawMetadata: result.rawMetadata,
          warnings: result.warnings,
        }, null, 2) + '\n', writeOptions);
        if (result.cover.length) {
          const extension = result.coverMimeType === 'image/png' ? 'png'
            : result.coverMimeType === 'image/jpeg' ? 'jpg' : 'bin';
          await writeFile(join(directory, `${stem}.cover.${extension}`), result.cover, writeOptions);
        }
      }
      for (const warning of result.warnings) console.warn(`[warning] ${file}: ${warning}`);
      console.log(`${file} -> ${destination}`);
    } catch (error) {
      console.error(`[error] ${file}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
