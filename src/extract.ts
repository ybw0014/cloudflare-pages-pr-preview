import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

export const ZIP_LIMIT = 256 * 1024 * 1024;
export const ENTRY_LIMIT = 20_000;
export const FILE_LIMIT = 25 * 1024 * 1024;
export const TOTAL_LIMIT = 1024 * 1024 * 1024;

function openZip(zipPath: string, validateEntrySizes: boolean): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(
      zipPath,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes, autoClose: false },
      (error, file) =>
        error ? reject(error) : file ? resolve(file) : reject(new Error("Unable to open ZIP")),
    ),
  );
}

function safeName(name: string): string {
  if (
    !name ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name)
  )
    throw new Error("Unsafe ZIP path");
  const parts = name.split("/");
  if (parts.some((part) => part === ".." || part === ".")) throw new Error("Unsafe ZIP path");
  if (parts[0] === "_worker.js") throw new Error("ZIP contains forbidden root _worker.js");
  return parts.filter(Boolean).join("/");
}

export async function extractZip(
  zipPath: string,
  destination: string,
  limits = { zip: ZIP_LIMIT, entries: ENTRY_LIMIT, file: FILE_LIMIT, total: TOTAL_LIMIT },
): Promise<void> {
  const stat = await fs.stat(zipPath);
  if (stat.size > limits.zip) throw new Error("ZIP exceeds size limit");
  await fs.mkdir(destination, { recursive: false });
  let zip: yauzl.ZipFile | undefined;
  let extractionZip: yauzl.ZipFile | undefined;
  try {
    const opened = (zip = await openZip(zipPath, true));
    const seen = new Map<string, boolean>();
    const entries: yauzl.Entry[] = [];
    let declaredTotal = 0;
    await new Promise<void>((resolve, reject) => {
      opened.on("error", reject);
      opened.on("end", resolve);
      opened.on("entry", (entry) => {
        try {
          if (entries.length >= limits.entries) throw new Error("ZIP exceeds entry limit");
          const isDir = entry.fileName.endsWith("/");
          const name = safeName(entry.fileName);
          if (!name) throw new Error("Invalid ZIP path");
          if (seen.has(name)) throw new Error(`Duplicate ZIP path: ${name}`);
          const parts = name.split("/");
          for (let i = 1; i < parts.length; i++) {
            const parent = parts.slice(0, i).join("/");
            if (seen.get(parent) === false)
              throw new Error(`File/directory path conflict: ${name}`);
          }
          if (!isDir && [...seen.keys()].some((prior) => prior.startsWith(`${name}/`)))
            throw new Error(`File/directory path conflict: ${name}`);
          seen.set(name, isDir);
          const mode = entry.externalFileAttributes >>> 16;
          const type = mode & 0o170000;
          if (type !== 0 && type !== 0o100000 && type !== 0o040000)
            throw new Error(`Special ZIP entry rejected: ${name}`);
          if (type !== 0 && isDir !== (type === 0o040000))
            throw new Error(`ZIP type mismatch: ${name}`);
          if (isDir && entry.uncompressedSize !== 0)
            throw new Error(`Directory entry has data: ${name}`);
          if (!isDir && entry.uncompressedSize > limits.file)
            throw new Error(`ZIP file exceeds size limit: ${name}`);
          declaredTotal += entry.uncompressedSize;
          if (declaredTotal > limits.total) throw new Error("ZIP exceeds expanded size limit");
          entries.push(entry);
          opened.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      opened.readEntry();
    });
    const index = entries.find(
      (entry) => safeName(entry.fileName) === "index.html" && !entry.fileName.endsWith("/"),
    );
    if (!index) throw new Error("ZIP must contain a regular root index.html");
    opened.close();
    const extracting = (extractionZip = await openZip(zipPath, false));
    const streamedEntries = await new Promise<yauzl.Entry[]>((resolve, reject) => {
      const rows: yauzl.Entry[] = [];
      extracting.on("error", reject);
      extracting.on("end", () => resolve(rows));
      extracting.on("entry", (entry) => {
        rows.push(entry);
        extracting.readEntry();
      });
      extracting.readEntry();
    });
    if (
      streamedEntries.length !== entries.length ||
      streamedEntries.some(
        (entry, i) =>
          entry.fileName !== entries[i].fileName ||
          entry.uncompressedSize !== entries[i].uncompressedSize ||
          entry.compressedSize !== entries[i].compressedSize ||
          entry.crc32 !== entries[i].crc32 ||
          entry.externalFileAttributes !== entries[i].externalFileAttributes,
      )
    )
      throw new Error("ZIP changed between validation and extraction");
    let actualTotal = 0;
    for (const entry of streamedEntries) {
      const rel = safeName(entry.fileName);
      const target = path.join(destination, rel);
      if (entry.fileName.endsWith("/")) {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      let bytes = 0;
      await new Promise<void>((resolve, reject) =>
        extracting.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            reject(error ?? new Error("Unable to read ZIP entry"));
            return;
          }
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              actualTotal += chunk.length;
              if (bytes > limits.file) callback(new Error("ZIP file actual size exceeds limit"));
              else if (actualTotal > limits.total)
                callback(new Error("ZIP actual expanded size exceeds limit"));
              else callback(null, chunk);
            },
          });
          pipeline(stream, counter, createWriteStream(target, { flags: "wx" })).then(
            () =>
              bytes === entry.uncompressedSize
                ? resolve()
                : reject(new Error("ZIP entry size mismatch")),
            reject,
          );
        }),
      );
    }
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    zip?.close();
    extractionZip?.close();
  }
}
