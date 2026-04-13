declare module '@serialport/binding-mock' {
  export class MockBinding {
    static createPort(path: string, options?: { echo?: boolean; record?: boolean }): void;
    static reset(): void;
    static list(): Promise<Array<{ path: string }>>;
    static open(options: Record<string, unknown>): Promise<MockBinding>;
    emitData(data: Buffer): void;
  }
}
