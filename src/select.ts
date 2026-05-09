import { which } from "bun";
import { C } from "./colors";

export async function selectSession(lines: string[]): Promise<string | null> {
	if (which("fzf")) {
		return selectWithFzf(lines);
	}
	return selectBuiltin(lines);
}

async function selectWithFzf(lines: string[]): Promise<string | null> {
	const proc = Bun.spawn(
		[
			"fzf",
			"--exact",
			"--ansi",
			"--header=Select a session  ● exists  ○ deleted",
			"--with-nth=6..",
			"--delimiter=\t",
			"--reverse",
			"--height=~60%",
			"--no-info",
			"--preview-window=hidden",
		],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		},
	);

	for (const line of lines) {
		proc.stdin.write(line + "\n");
	}
	proc.stdin.flush();
	proc.stdin.end();

	const exitCode = await proc.exited;
	if (exitCode !== 0) return null;

	const output = await new Response(proc.stdout).text();
	return output.trim() || null;
}

async function selectBuiltin(lines: string[]): Promise<string | null> {
	const maxDisplay = Math.min(lines.length, 20);

	process.stderr.write(`${C.bold}Select a session${C.reset}  ● exists  ○ deleted\n\n`);

	for (let i = 0; i < maxDisplay; i++) {
		const display = lines[i]!.split("\t").slice(5).join("\t");
		process.stderr.write(`  ${C.dim}${String(i + 1).padStart(2)}${C.reset}  ${display}\n`);
	}
	if (lines.length > maxDisplay) {
		process.stderr.write(`  ${C.dim}... and ${lines.length - maxDisplay} more (install fzf for full search)${C.reset}\n`);
	}

	process.stderr.write(`\n${C.bold}Enter number (1-${maxDisplay})${C.reset}: `);

	const reader = Bun.stdin.stream().getReader();
	const { value } = await reader.read();
	reader.releaseLock();

	if (!value) return null;
	const input = new TextDecoder().decode(value).trim();
	const num = parseInt(input, 10);
	if (isNaN(num) || num < 1 || num > maxDisplay) return null;

	return lines[num - 1] ?? null;
}
