/** The two file operations a durable append needs; injectable so order is testable. */
export interface DurableFs {
  write(fd: number, text: string): Promise<void>;
  fsync(fd: number): Promise<void>;
}

/** Writes `line`, then fsyncs; resolves only after both have completed. */
export const durableAppend = async (fs: DurableFs, fd: number, line: string): Promise<void> => {
  await fs.write(fd, line);
  await fs.fsync(fd);
};
