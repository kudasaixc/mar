/**
 * Discover verification commands for a project when none are configured:
 * package.json scripts (with the detected package manager), Cargo, Go, and pytest.
 */
export declare function detectChecks(root: string): Promise<Record<string, string>>;
//# sourceMappingURL=checks.d.ts.map