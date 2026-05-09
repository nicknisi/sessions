import { which } from "bun";

export async function copyToClipboard(text: string): Promise<boolean> {
	const cmd = which("pbcopy") ? "pbcopy" : which("xclip") ? "xclip" : null;
	if (!cmd) return false;

	const args = cmd === "xclip" ? [cmd, "-selection", "clipboard"] : [cmd];
	const proc = Bun.spawn(args, { stdin: "pipe" });
	proc.stdin.write(text);
	proc.stdin.flush();
	proc.stdin.end();
	await proc.exited;
	return true;
}
