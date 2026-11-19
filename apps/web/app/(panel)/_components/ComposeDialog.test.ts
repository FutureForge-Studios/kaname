import { describe, expect, it } from "vitest";
import { rawGitHubUrl } from "./ComposeDialog";

describe("rawGitHubUrl", () => {
  it("builds the raw URL for a public repo", () => {
    expect(rawGitHubUrl("https://github.com/acme/app.git", "main", "deploy/compose.yaml")).toBe(
      "https://raw.githubusercontent.com/acme/app/main/deploy/compose.yaml",
    );
    expect(rawGitHubUrl("https://github.com/acme/app/", "release/1.2", "docker-compose.yml")).toBe(
      "https://raw.githubusercontent.com/acme/app/release/1.2/docker-compose.yml",
    );
  });

  it("refuses anything that could leave the repository or GitHub", () => {
    for (const [repo, branch, path] of [
      ["https://github.com/acme/app", "main", "../../other/repo/main/x.yml"],
      ["https://github.com/acme/app", "..", "x.yml"],
      ["https://github.com/acme/..", "main", "x.yml"],
      ["https://github.com/acme/app", "main", "/etc/passwd"],
      ["https://github.com/acme/app", "main", "a//b.yml"],
      ["https://github.com/acme/app", "main", "a/%2e%2e/b.yml"],
      ["https://evil.com/acme/app", "main", "x.yml"],
      ["http://github.com/acme/app", "main", "x.yml"],
      ["https://github.com/acme/app?x=1", "main", "x.yml"],
    ]) {
      expect(rawGitHubUrl(repo!, branch!, path!)).toBeNull();
    }
  });
});
