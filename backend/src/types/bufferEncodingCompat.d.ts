declare global {
  interface BufferConstructor {
    from(string: string, encoding: string | undefined): Buffer;
  }
}

export {};
