import { resolve } from "node:path";

export class FileActivityTracker {
  private written = new Set<string>();

  trackWrite(path: string, cwd: string) {
    this.written.add(this.normalize(path, cwd));
  }

  hasWritten(path: string, cwd: string): boolean {
    return this.written.has(this.normalize(path, cwd));
  }

  get writeCount(): number {
    return this.written.size;
  }

  private normalize(path: string, cwd: string): string {
    return resolve(cwd, path);
  }
}
