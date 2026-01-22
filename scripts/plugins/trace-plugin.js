import { BasePlugin } from "./base-plugin";


export class TracePlugin extends BasePlugin {
    static NAME = 'TracePlugin';

    constructor() {
        super(TracePlugin.NAME)
    }

    apply(bs) {
        bs.hooks.parseParams.tap(this.name, () => {
            if (bs.options.trace) {
                this.setEnv('RUST_BACKTRACE', "full")
            }
        });
    }
}
