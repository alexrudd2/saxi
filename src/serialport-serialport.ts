import { EventEmitter } from 'events'
import { default as NodeSerialPort } from 'serialport'

function readableStreamFromAsyncIterable<T> (iterable: AsyncIterable<T>) {
  const it = iterable[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull (controller) {
      const { done, value } = await it.next()
      if (done) {
        controller.close()
      } else {
        controller.enqueue(value)
      }
    },
    async cancel (reason) {
      await it.throw(reason)
    }
  }, { highWaterMark: 0 })
}

export class SerialPortSerialPort extends EventEmitter implements SerialPort {
  private readonly _path: string
  private _port: NodeSerialPort

  public constructor (path: string) {
    super()
    this._path = path
  }

  public onconnect: (this: this, ev: Event) => any
  public ondisconnect: (this: this, ev: Event) => any
  public readable: ReadableStream<Uint8Array>
  public writable: WritableStream<Uint8Array>

  public async forget (): Promise<void> {
    return await Promise.resolve()
  }

  public async open (options: SerialOptions): Promise<void> {
    const opts: NodeSerialPort.OpenOptions = {
      baudRate: options.baudRate
    }
    if (options.dataBits != null) { opts.dataBits = options.dataBits as any }
    if (options.stopBits != null) { opts.stopBits = options.stopBits as any }
    if (options.parity != null) { opts.parity = options.parity }

    /*
      TODO:
      bufferSize?: number | undefined;
      flowControl?: FlowControlType | undefined;
      */
    return await new Promise((resolve, reject) => {
      this._port = new NodeSerialPort(this._path, opts, (err) => {
        this._port.once('close', () => this.emit('disconnect'))
        if (err) reject(err)
        else {
          // Drain the port
          while (this._port.read() != null) { /* do nothing */ }
          resolve()
        }
      })
      this.readable = readableStreamFromAsyncIterable(this._port)
      this.writable = new WritableStream({
        write: async (chunk) => {
          return await new Promise((resolve, reject) => {
            this._port.write(Buffer.from(chunk), (err, _bytesWritten) => {
              if (err) reject(err)
              else resolve()
              // TODO: check bytesWritten?
            })
          })
        }
      })
    })
  }

  public async setSignals (signals: SerialOutputSignals): Promise<void> {
    return await new Promise((resolve, reject) => {
      this._port.set({
        dtr: signals.dataTerminalReady,
        rts: signals.requestToSend,
        brk: signals.break
      }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  public async getSignals (): Promise<SerialInputSignals> {
    throw new Error('Method not implemented.')
  }

  public getInfo (): SerialPortInfo {
    throw new Error('Method not implemented.')
  }

  public async close (): Promise<void> {
    return await new Promise((resolve, reject) => {
      this._port.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  public addEventListener (type: 'connect' | 'disconnect', listener: (this: this, ev: Event) => any, useCapture?: boolean): void
  public addEventListener (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void
  public addEventListener (type: any, listener: any, options?: any): void {
    if (typeof options === 'object' && options.once) {
      this.once(type, listener)
    } else {
      this.on(type, listener)
    }
  }

  public removeEventListener (type: 'connect' | 'disconnect', callback: (this: this, ev: Event) => any, useCapture?: boolean): void
  public removeEventListener (type: string, callback: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void
  public removeEventListener (type: any, callback: any, options?: any): void {
    if (typeof options === 'object' && options.once) {
      this.off(type, callback)
    } else {
      this.off(type, callback)
    }
  }

  public dispatchEvent (event: Event): boolean {
    return this.emit(event.type)
  }
}
