interface FileSystemFileHandle {
  createSyncAccessHandle?(): Promise<FileSystemSyncAccessHandle>;
}

interface FileSystemSyncAccessHandle {
  read(buffer: BufferSource, options?: { at: number }): number;
  write(buffer: BufferSource, options?: { at: number }): number;
  getSize(): number;
  truncate(newSize: number): void;
  flush(): void;
  close(): void;
}
