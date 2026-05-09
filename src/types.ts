export type Tool = "claude" | "pi" | "codex";

export interface SessionResult {
	date: string;
	cwd: string;
	tool: Tool;
	sessionId: string;
	displayText: string;
	filePath: string;
	exists: boolean;
}

export interface CliArgs {
	toolFilter: Tool | "";
	searchQuery: string;
	scopeHere: boolean;
}
