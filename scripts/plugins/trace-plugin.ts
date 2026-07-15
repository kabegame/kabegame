import { BasePlugin } from "./base-plugin.ts";


export class TracePlugin extends BasePlugin {
    static readonly NAME = 'TracePlugin';

    constructor() {
        super(TracePlugin.NAME)
    }

    apply(bs: any): void {
        bs.hooks.parseParams.tap(this.name, () => {
            if (bs.options.trace) {
                this.setEnv('RUST_BACKTRACE', "1")
            }
        });
    }
}
