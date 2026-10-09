/** Minimal in-memory File System Access API for unit tests. */
class FakeWritable {
  private chunks: BlobPart[] = [];
  constructor(private readonly target: FakeFileHandle) {}
  async write(data: BlobPart) {
    this.chunks.push(data);
  }
  async close() {
    this.target.data = new Blob(this.chunks);
  }
}

export class FakeFileHandle {
  readonly kind = "file" as const;
  parent: FakeDirHandle | null = null;
  constructor(
    public name: string,
    public data: Blob = new Blob([]),
  ) {}
  async getFile() {
    return new File([this.data], this.name, { lastModified: 1_700_000_000_000 });
  }
  async createWritable() {
    return new FakeWritable(this);
  }
  async queryPermission() {
    return "granted" as const;
  }
  async isSameEntry(other: unknown) {
    return other === this;
  }
}

export class FakeDirHandle {
  readonly kind = "directory" as const;
  readonly children = new Map<string, FakeDirHandle | FakeFileHandle>();
  constructor(public name: string) {}

  private find(name: string) {
    // Case-insensitive like Windows.
    for (const [key, child] of this.children) if (key.toLowerCase() === name.toLowerCase()) return child;
    return undefined;
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    const child = this.find(name);
    if (child instanceof FakeDirHandle) return child;
    if (child) throw new DOMException("type mismatch", "TypeMismatchError");
    if (!opts?.create) throw new DOMException(`${name} not found`, "NotFoundError");
    const dir = new FakeDirHandle(name);
    this.children.set(name, dir);
    return dir;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    const child = this.find(name);
    if (child instanceof FakeFileHandle) return child;
    if (child) throw new DOMException("type mismatch", "TypeMismatchError");
    if (!opts?.create) throw new DOMException(`${name} not found`, "NotFoundError");
    const file = new FakeFileHandle(name);
    file.parent = this;
    this.children.set(name, file);
    return file;
  }
  async removeEntry(name: string) {
    for (const key of this.children.keys())
      if (key.toLowerCase() === name.toLowerCase()) {
        this.children.delete(key);
        return;
      }
    throw new DOMException(`${name} not found`, "NotFoundError");
  }
  async *entries(): AsyncGenerator<[string, FakeDirHandle | FakeFileHandle]> {
    for (const entry of this.children) yield entry;
  }
  async queryPermission() {
    return "granted" as const;
  }
  async requestPermission() {
    return "granted" as const;
  }
  async isSameEntry(other: unknown) {
    return other === this;
  }

  /** Test helper: create a file with content at a "/"-path. */
  async put(path: string, content: string) {
    const parts = path.split("/");
    const name = parts.pop()!;
    let dir: FakeDirHandle = this;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
    const file = await dir.getFileHandle(name, { create: true });
    file.data = new Blob([content]);
    return file;
  }
  /** Test helper: list all file paths. */
  paths(prefix = ""): string[] {
    return [...this.children].flatMap(([name, child]) =>
      child instanceof FakeDirHandle ? child.paths(`${prefix}${name}/`) : [`${prefix}${name}`],
    );
  }
  async read(path: string) {
    const parts = path.split("/");
    const name = parts.pop()!;
    let dir: FakeDirHandle = this;
    for (const p of parts) dir = await dir.getDirectoryHandle(p);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }
}

/** Adds FileSystemHandle.move() support, like Chrome 110+. */
export function withNativeMove(root: FakeDirHandle) {
  const patch = (dir: FakeDirHandle) => {
    const orig = dir.getFileHandle.bind(dir);
    dir.getFileHandle = async (name, opts) => {
      const handle = await orig(name, opts);
      Object.assign(handle, {
        move: async (dest: FakeDirHandle, newName?: string) => {
          await handle.parent!.removeEntry(handle.name);
          handle.name = newName ?? handle.name;
          handle.parent = dest;
          dest.children.set(handle.name, handle);
        },
      });
      return handle;
    };
    const origDir = dir.getDirectoryHandle.bind(dir);
    dir.getDirectoryHandle = async (name, opts) => {
      const child = await origDir(name, opts);
      patch(child);
      return child;
    };
  };
  patch(root);
  return root;
}

export const asDir = (d: FakeDirHandle) => d as unknown as FileSystemDirectoryHandle;
