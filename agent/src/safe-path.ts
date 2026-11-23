import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function resolveExistingPath(root: string, path: string): Promise<string> {
  if (!path.trim() || isAbsolute(path)) throw new Error("path must be relative");
  await mkdir(root, { recursive: true });
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, path);
  if (!inside(rootReal, candidate)) throw new Error("path escapes the allowed root");
  const candidateReal = await realpath(candidate);
  if (!inside(rootReal, candidateReal)) throw new Error("path escapes the allowed root");
  return candidateReal;
}

export async function resolveWritablePath(root: string, path: string): Promise<string> {
  if (!path.trim() || isAbsolute(path)) throw new Error("path must be relative");
  await mkdir(root, { recursive: true });
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, path);
  if (!inside(rootReal, candidate)) throw new Error("path escapes the allowed root");

  const parent = dirname(candidate);
  await mkdir(parent, { recursive: true });
  const parentReal = await realpath(parent);
  if (!inside(rootReal, parentReal)) throw new Error("path escapes the allowed root");

  try {
    const current = await stat(candidate);
    if (!current.isFile()) throw new Error("target path is not a file");
    const candidateReal = await realpath(candidate);
    if (!inside(rootReal, candidateReal)) throw new Error("path escapes the allowed root");
    return candidateReal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
    throw error;
  }
}
