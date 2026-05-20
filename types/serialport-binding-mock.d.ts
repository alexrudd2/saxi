// https://github.com/serialport/node-serialport/issues/2770
declare module '@serialport/binding-mock' {
	import type { BindingPortInterface, PortInfo } from '@serialport/bindings-interface';

	export interface MockBindingInterface {
		createPort(path: string, options?: unknown): void;
		list(): Promise<PortInfo[]>;
		open(options: unknown): Promise<BindingPortInterface>;
		close(): Promise<void>;
		read(buffer: Buffer, offset: number, length: number): Promise<{ bytesRead: number; buffer: Buffer }>;
		write(buffer: Buffer): Promise<void>;
		update(options: unknown): Promise<void>;
		set(options: unknown): Promise<void>;
		get(): Promise<unknown>;
		getBaudRate(): Promise<{ baudRate: number }>;
		flush(): Promise<void>;
		drain(): Promise<void>;
	}

	export const MockBinding: MockBindingInterface;
}