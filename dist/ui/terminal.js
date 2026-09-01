import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
const enabled = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const ansi = (code, text) => enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
export const colors = {
    cyan: (text) => ansi(36, text),
    green: (text) => ansi(32, text),
    yellow: (text) => ansi(33, text),
    red: (text) => ansi(31, text),
    gray: (text) => ansi(90, text),
    bold: (text) => ansi(1, text),
};
export function createTerminal() {
    return createInterface({ input: stdin, output: stdout, terminal: Boolean(stdout.isTTY) });
}
export class ApprovalPrompt {
    terminal;
    tail = Promise.resolve();
    constructor(terminal) {
        this.terminal = terminal;
    }
    handler = (request) => {
        const answer = this.tail.then(async () => {
            stdout.write(`\n${colors.yellow("approval required")} ${colors.bold(request.agent)} → ${request.tool}\n${request.detail}\n`);
            const value = await this.terminal.question("Allow once? [y/N] ");
            return /^(y|yes|o|oui)$/i.test(value.trim());
        });
        this.tail = answer.catch(() => undefined);
        return answer;
    };
}
export function printEvent(event) {
    switch (event.type) {
        case "agent:start":
            stdout.write(`\n${colors.cyan(`[${event.agent}]`)} ${colors.gray(event.model)}\n`);
            break;
        case "agent:text":
            stdout.write(`${event.text}\n`);
            break;
        case "agent:tool":
            stdout.write(`${colors.gray("  →")} ${colors.yellow(event.tool)} ${colors.gray(event.detail)}\n`);
            break;
        case "agent:tool-result":
            stdout.write(`${event.ok ? colors.green("  ✓") : colors.red("  ✗")} ${event.tool} ${colors.gray(event.preview.replaceAll("\n", " "))}\n`);
            break;
        case "agent:fallback":
            stdout.write(`${colors.yellow("  ↻ fallback")} ${event.model}: ${event.error}\n`);
            break;
        case "agent:end":
            stdout.write(`${colors.gray(`[${event.agent} completed in ${event.turns} turn(s)]`)}\n`);
            break;
    }
}
export function banner() {
    return `${colors.cyan(colors.bold("MAR"))}  ${colors.gray("Multi-Agent Router")}`;
}
//# sourceMappingURL=terminal.js.map