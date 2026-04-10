import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

const LOCAL_DIR = "caduceus_data";

export async function readJson<T>(name: string): Promise<T | null> {
  const localPath = resolve(process.cwd(), LOCAL_DIR, name);
  if (!existsSync(localPath)) return null;
  try {
    return JSON.parse(readFileSync(localPath, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeJson<T>(name: string, data: T): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const localPath = resolve(process.cwd(), LOCAL_DIR, name);
  mkdirSync(dirname(localPath), { recursive: true });
  writeFileSync(localPath, json, "utf8");
}
