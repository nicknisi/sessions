const isTTY = process.stderr.isTTY;
const noColor = !!process.env.NO_COLOR;
let forceNoColor = false;

export function disableColors() {
	forceNoColor = true;
}

function code(c: string): string {
	if (forceNoColor || noColor || !isTTY) return "";
	return c;
}

export const C = {
	get reset() { return code("\x1b[0m"); },
	get bold() { return code("\x1b[1m"); },
	get dim() { return code("\x1b[2m"); },
	get red() { return code("\x1b[0;31m"); },
	get green() { return code("\x1b[0;32m"); },
	get blue() { return code("\x1b[0;34m"); },
	get purple() { return code("\x1b[0;35m"); },
	get cyan() { return code("\x1b[0;36m"); },
	get yellow() { return code("\x1b[1;33m"); },
	get gray() { return code("\x1b[0;90m"); },
} as const;

export const toolColor: Record<string, string> = {
	claude: C.purple,
	pi: C.green,
	codex: C.blue,
};
