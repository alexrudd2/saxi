import "web-streams-polyfill/polyfill";

/**
 * Process a Stream by splitting it using a regular expression as a separator.
 */
export class RegexParser extends TransformStream {
  /**
   * @param opts regular expression of a separator.
   */
  public constructor(opts: { regex: RegExp }) {
    if (opts.regex === undefined) {
      throw new TypeError('"options.regex" must be a regular expression pattern or object');
    }

    if (!(opts.regex instanceof RegExp)) {
      opts.regex = new RegExp(opts.regex);
    }

    const regex = opts.regex;
    let data = '';
    const decoder = new TextDecoder();
    super({
      transform(chunk, controller) {
        const newData = data + decoder.decode(chunk);
        const parts = newData.split(regex);
        data = parts.pop();
        for (const part of parts) {
          controller.enqueue(part);
        }
      },
      flush(controller) {
        controller.enqueue(data);
        data = '';
      }
    });
  }
}
