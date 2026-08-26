//go:build linux

package linux

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Backups.
 *
 * restic does the work. The interesting decision here is where the
 * repository password comes from: the control plane sends a *reference*,
 * never the secret itself, and the agent resolves it against files in
 * its own state directory. A compromised control plane therefore cannot
 * read a repository it does not already have the key for, and the
 * password never travels over the socket or appears in an argv.
 * ------------------------------------------------------------------ */

const (
	// Where password references resolve to, under the agent's state dir.
	backupSecretsDir = "backup-secrets"
	// How often a running backup reports progress upward.
	backupProgressInterval = time.Second
)

var restoredSummary = regexp.MustCompile(`restored\s+(\d+)\s+files?.*?\(([0-9.]+)\s*([KMGT]?i?B)\)`)

type backupOps struct{ p *provider }

/* --------------------------------- run -------------------------------- */

func (o backupOps) Run(ctx context.Context, p providers.BackupRunParams, stream providers.Stream) (providers.BackupSnapshotInfo, error) {
	environment, err := o.environment(p.Repository, p.PasswordRef)
	if err != nil {
		return providers.BackupSnapshotInfo{}, err
	}

	paths := append([]string(nil), p.Paths...)

	// Databases are dumped to a staging directory and backed up with the
	// files, so one snapshot is a consistent picture of the whole host.
	if len(p.Databases) > 0 {
		staging, err := os.MkdirTemp("", "kaname-backup-")
		if err != nil {
			return providers.BackupSnapshotInfo{}, fmt.Errorf("create staging directory: %w", err)
		}
		defer os.RemoveAll(staging)

		for _, database := range p.Databases {
			if err := checkEngineName(database.Engine); err != nil {
				return providers.BackupSnapshotInfo{}, err
			}
			if err := checkSQLIdentifier(database.Name); err != nil {
				return providers.BackupSnapshotInfo{}, err
			}
			destination := filepath.Join(staging, database.Engine+"-"+database.Name+".sql")
			if _, err := (databaseOps{o.p}).Dump(ctx, providers.DbDumpParams{
				Engine:      database.Engine,
				Name:        database.Name,
				Destination: destination,
				Compress:    true,
			}, stream); err != nil {
				return providers.BackupSnapshotInfo{}, err
			}
		}
		paths = append(paths, staging)
	}

	if len(paths) == 0 {
		return providers.BackupSnapshotInfo{}, invalid("a backup needs at least one path or database")
	}
	if err := o.ensureRepository(ctx, environment); err != nil {
		return providers.BackupSnapshotInfo{}, err
	}

	args := []string{"backup", "--json"}
	for _, exclude := range p.Exclude {
		if strings.ContainsRune(exclude, 0) {
			return providers.BackupSnapshotInfo{}, invalid("exclude patterns may not contain a null byte")
		}
		args = append(args, "--exclude", exclude)
	}
	for _, tag := range p.Tags {
		if err := checkTag(tag); err != nil {
			return providers.BackupSnapshotInfo{}, err
		}
		args = append(args, "--tag", tag)
	}
	args = append(args, paths...)

	snapshot := providers.BackupSnapshotInfo{TakenAt: nowRFC3339(), Paths: paths, Tags: p.Tags}
	if snapshot.Tags == nil {
		snapshot.Tags = []string{}
	}

	err = o.stream(ctx, stream, environment, args, func(message resticMessage, raw string) {
		switch message.MessageType {
		case "summary":
			snapshot.ID = message.SnapshotID
			snapshot.Bytes = message.TotalBytesProcessed
			snapshot.FileCount = message.TotalFilesProcessed
		case "error":
			o.p.log.Warn("restic reported an error", "message", truncateString(raw, 500))
		}
	})
	if err != nil {
		return providers.BackupSnapshotInfo{}, err
	}
	if snapshot.ID == "" {
		return providers.BackupSnapshotInfo{}, precondition("restic finished without reporting a snapshot id")
	}
	return snapshot, nil
}

/* -------------------------------- list -------------------------------- */

func (o backupOps) List(ctx context.Context, p providers.BackupListParams) ([]providers.BackupSnapshotInfo, error) {
	environment, err := o.environment(p.Repository, p.PasswordRef)
	if err != nil {
		return nil, err
	}

	out, err := runWith(ctx, execOptions{Name: "restic", Args: []string{"snapshots", "--json"}, Env: environment})
	if err != nil {
		return nil, err
	}

	var raw []struct {
		ID      string   `json:"id"`
		ShortID string   `json:"short_id"`
		Time    string   `json:"time"`
		Paths   []string `json:"paths"`
		Tags    []string `json:"tags"`
		Summary *struct {
			TotalBytesProcessed int64 `json:"total_bytes_processed"`
			TotalFilesProcessed int   `json:"total_files_processed"`
		} `json:"summary"`
	}
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		return nil, fmt.Errorf("decode restic snapshots: %w", err)
	}

	snapshots := make([]providers.BackupSnapshotInfo, 0, len(raw))
	for _, entry := range raw {
		snapshot := providers.BackupSnapshotInfo{
			ID:      entry.ID,
			TakenAt: normalizeTimestamp(entry.Time),
			Paths:   orEmpty(entry.Paths),
			Tags:    orEmpty(entry.Tags),
		}
		// restic only records a summary from 0.17 onward; an older
		// repository reports the snapshot without inventing figures for it.
		if entry.Summary != nil {
			snapshot.Bytes = entry.Summary.TotalBytesProcessed
			snapshot.FileCount = entry.Summary.TotalFilesProcessed
		}
		snapshots = append(snapshots, snapshot)
	}

	sortSlice(snapshots, func(a, b providers.BackupSnapshotInfo) bool { return a.TakenAt > b.TakenAt })
	return snapshots, nil
}

/* ------------------------------- restore ------------------------------ */

func (o backupOps) Restore(ctx context.Context, p providers.BackupRestoreParams, stream providers.Stream) (providers.BackupRestoreResult, error) {
	environment, err := o.environment(p.Repository, p.PasswordRef)
	if err != nil {
		return providers.BackupRestoreResult{}, err
	}
	if err := checkSnapshotID(p.SnapshotID); err != nil {
		return providers.BackupRestoreResult{}, err
	}
	if err := os.MkdirAll(p.Target, defaultDirMode); err != nil {
		return providers.BackupRestoreResult{}, wrapFsError(p.Target, err)
	}
	if !p.Overwrite {
		entries, err := os.ReadDir(p.Target)
		if err == nil && len(entries) > 0 {
			return providers.BackupRestoreResult{}, fmt.Errorf("%s is not empty and overwrite was not requested: %w", p.Target, providers.ErrConflict)
		}
	}

	args := []string{"restore", p.SnapshotID, "--target", p.Target, "--json"}
	for _, include := range p.Include {
		if strings.ContainsRune(include, 0) {
			return providers.BackupRestoreResult{}, invalid("include patterns may not contain a null byte")
		}
		args = append(args, "--include", include)
	}

	result := providers.BackupRestoreResult{}
	err = o.stream(ctx, stream, environment, args, func(message resticMessage, raw string) {
		if message.MessageType == "summary" {
			result.RestoredFiles = message.FilesRestored
			result.Bytes = message.TotalBytes
		}
		// Older restic prints a plain sentence instead of a summary object.
		if match := restoredSummary.FindStringSubmatch(raw); match != nil && result.RestoredFiles == 0 {
			result.RestoredFiles, _ = strconv.Atoi(match[1])
			result.Bytes = parseHumanBytes(match[2], match[3])
		}
	})
	if err != nil {
		return providers.BackupRestoreResult{}, err
	}
	return result, nil
}

/* -------------------------------- verify ------------------------------ */

func (o backupOps) Verify(ctx context.Context, p providers.BackupVerifyParams, stream providers.Stream) (providers.BackupVerifyResult, error) {
	environment, err := o.environment(p.Repository, p.PasswordRef)
	if err != nil {
		return providers.BackupVerifyResult{}, err
	}
	if err := checkSnapshotID(p.SnapshotID); err != nil {
		return providers.BackupVerifyResult{}, err
	}

	result := providers.BackupVerifyResult{OK: true, Errors: []string{}}

	// `check` proves the repository's structure; reading a subset proves
	// the packs actually decrypt. Neither alone is a verification.
	if _, err := runStream(ctx, stream, execOptions{
		Name: "restic",
		Args: []string{"check", "--read-data-subset=5%"},
		Env:  environment,
	}); err != nil {
		result.OK = false
		result.Errors = append(result.Errors, err.Error())
	}

	if _, err := runStream(ctx, stream, execOptions{
		Name: "restic",
		Args: []string{"stats", "--json", "--mode", "raw-data", p.SnapshotID},
		Env:  environment,
	}); err != nil {
		result.OK = false
		result.Errors = append(result.Errors, err.Error())
	}
	return result, nil
}

/* -------------------------------- prune ------------------------------- */

func (o backupOps) Prune(ctx context.Context, p providers.BackupPruneParams, stream providers.Stream) (providers.BackupPruneResult, error) {
	environment, err := o.environment(p.Repository, p.PasswordRef)
	if err != nil {
		return providers.BackupPruneResult{}, err
	}

	args := []string{"forget", "--prune", "--json"}
	for _, policy := range []struct {
		flag  string
		value int
	}{
		{"--keep-last", p.KeepLast},
		{"--keep-daily", p.KeepDaily},
		{"--keep-weekly", p.KeepWeekly},
		{"--keep-monthly", p.KeepMonthly},
	} {
		if policy.value > 0 {
			args = append(args, policy.flag, strconv.Itoa(policy.value))
		}
	}
	if len(args) == 3 {
		return providers.BackupPruneResult{}, invalid("a retention policy needs at least one keep rule")
	}

	// Repository size before and after is the only figure restic reports
	// consistently across versions, so reclaimed space is measured rather
	// than parsed out of prose.
	before := o.repositorySize(ctx, environment)

	out, err := runStream(ctx, stream, execOptions{Name: "restic", Args: args, Env: environment})
	if err != nil {
		return providers.BackupPruneResult{}, err
	}

	after := o.repositorySize(ctx, environment)
	reclaimed := before - after
	if reclaimed < 0 {
		reclaimed = 0
	}
	return providers.BackupPruneResult{Removed: countForgotten(out), ReclaimedBytes: reclaimed}, nil
}

/* ------------------------------- internals ---------------------------- */

// resticMessage is the subset of restic's JSON protocol the agent reads.
type resticMessage struct {
	MessageType         string  `json:"message_type"`
	PercentDone         float64 `json:"percent_done"`
	SnapshotID          string  `json:"snapshot_id"`
	TotalBytesProcessed int64   `json:"total_bytes_processed"`
	TotalFilesProcessed int     `json:"total_files_processed"`
	FilesRestored       int     `json:"files_restored"`
	TotalBytes          int64   `json:"total_bytes"`
}

// stream runs restic and relays its progress, throttling the status
// firehose to something a human can read while letting every error and
// summary through untouched.
func (o backupOps) stream(ctx context.Context, out providers.Stream, environment, args []string, observe func(resticMessage, string)) error {
	if err := o.p.require(providers.CapRestic); err != nil {
		return err
	}
	path, err := exec.LookPath("restic")
	if err != nil {
		return unsupported("restic is not installed")
	}

	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = environment
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("open restic pipe: %w", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return execError("restic", stderr.String(), err)
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64<<10), maxLogLine)
	lastReport := time.Time{}

	for scanner.Scan() {
		line := scanner.Text()

		var message resticMessage
		if err := json.Unmarshal([]byte(line), &message); err != nil {
			message = resticMessage{MessageType: "text"}
		}
		observe(message, line)

		if out == nil {
			continue
		}
		if message.MessageType == "status" {
			if time.Since(lastReport) < backupProgressInterval {
				continue
			}
			lastReport = time.Now()
			line = fmt.Sprintf("%.1f%% complete", message.PercentDone*100)
		}
		if err := out.Send(ctx, []byte(line+"\n"), providers.EncodingUTF8); err != nil {
			// The socket is gone, so restic is stopped rather than left
			// writing into a pipe nobody will ever read again.
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			_ = cmd.Wait()
			return err
		}
	}

	if err := cmd.Wait(); err != nil {
		return execError("restic", stderr.String(), err)
	}
	return nil
}

// ensureRepository initialises a repository the first time it is used,
// so a new destination does not need a manual `restic init` on the host.
func (o backupOps) ensureRepository(ctx context.Context, environment []string) error {
	if _, err := runWith(ctx, execOptions{Name: "restic", Args: []string{"cat", "config"}, Env: environment}); err == nil {
		return nil
	}
	_, err := runWith(ctx, execOptions{Name: "restic", Args: []string{"init"}, Env: environment})
	return err
}

func (o backupOps) repositorySize(ctx context.Context, environment []string) int64 {
	out, err := runWith(ctx, execOptions{Name: "restic", Args: []string{"stats", "--json", "--mode", "raw-data"}, Env: environment})
	if err != nil {
		return 0
	}
	var stats struct {
		TotalSize int64 `json:"total_size"`
	}
	if err := json.Unmarshal([]byte(out), &stats); err != nil {
		return 0
	}
	return stats.TotalSize
}

// environment resolves the password reference to a file the agent holds
// and builds restic's environment. The reference is a name, never a
// path: a control plane must not be able to point it at /etc/shadow.
func (o backupOps) environment(repository, passwordRef string) ([]string, error) {
	if err := o.p.require(providers.CapRestic); err != nil {
		return nil, err
	}
	if err := checkRepositoryURI(repository); err != nil {
		return nil, err
	}
	if err := checkSecretRef(passwordRef); err != nil {
		return nil, err
	}

	secretsDir := filepath.Join(o.p.opts.StateDir, backupSecretsDir)
	passwordFile := filepath.Join(secretsDir, passwordRef)
	if !fileExists(passwordFile) {
		return nil, precondition("no backup secret named %q in %s; install it on the host before running a backup", passwordRef, secretsDir)
	}

	environment := append(cLocale(),
		"RESTIC_REPOSITORY="+repository,
		"RESTIC_PASSWORD_FILE="+passwordFile,
	)

	// An object-store repository also needs credentials, which live beside
	// the password under the same reference and never cross the socket.
	if extra, err := os.ReadFile(passwordFile + ".env"); err == nil {
		for _, line := range splitLines(string(extra)) {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") {
				continue
			}
			if key, _, ok := strings.Cut(trimmed, "="); ok && key != "" {
				environment = append(environment, trimmed)
			}
		}
	}
	return environment, nil
}

func countForgotten(out string) int {
	var groups []struct {
		Remove []struct {
			ID string `json:"id"`
		} `json:"remove"`
	}
	// forget prints a JSON array before prune's own output, so only the
	// leading array is decoded.
	decoder := json.NewDecoder(strings.NewReader(out))
	if err := decoder.Decode(&groups); err != nil {
		return 0
	}

	removed := 0
	for _, group := range groups {
		removed += len(group.Remove)
	}
	return removed
}

func parseHumanBytes(value, unit string) int64 {
	amount, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0
	}
	multipliers := map[string]float64{
		"B": 1, "KiB": 1 << 10, "MiB": 1 << 20, "GiB": 1 << 30, "TiB": 1 << 40,
		"KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12,
	}
	multiplier, ok := multipliers[unit]
	if !ok {
		return int64(amount)
	}
	return int64(amount * multiplier)
}

func orEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

/* ------------------------------ validation ---------------------------- */

// checkSecretRef keeps a password reference a bare name, so it can only
// ever resolve inside the agent's own secrets directory.
func checkSecretRef(ref string) error {
	if ref == "" || len(ref) > 128 {
		return invalid("password_ref must be between 1 and 128 characters")
	}
	if strings.ContainsAny(ref, `/\`) || strings.Contains(ref, "..") || strings.ContainsRune(ref, 0) {
		return invalid("password_ref must be a bare name, not a path")
	}
	for i := 0; i < len(ref); i++ {
		c := ref[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '.', c == '-', c == '_':
		default:
			return invalid("password_ref contains an illegal character")
		}
	}
	return nil
}

func checkRepositoryURI(repository string) error {
	if repository == "" || len(repository) > 512 {
		return invalid("repository must be between 1 and 512 characters")
	}
	if strings.ContainsAny(repository, "\n\r") || strings.ContainsRune(repository, 0) || strings.HasPrefix(repository, "-") {
		return invalid("repository contains an illegal character")
	}
	return nil
}

func checkSnapshotID(id string) error {
	if id == "" || len(id) > 128 {
		return invalid("snapshot_id must be between 1 and 128 characters")
	}
	if id == "latest" {
		return nil
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'f', c >= 'A' && c <= 'F', c >= '0' && c <= '9':
		default:
			return invalid("snapshot_id must be a hex identifier or `latest`")
		}
	}
	return nil
}

func checkTag(tag string) error {
	if tag == "" || len(tag) > 64 {
		return invalid("tags must be between 1 and 64 characters")
	}
	if strings.ContainsAny(tag, " ,\n\r") || strings.ContainsRune(tag, 0) {
		return invalid("tag %q contains an illegal character", tag)
	}
	return nil
}

func checkEngineName(engine string) error {
	switch engine {
	case "mysql", "mariadb", "postgres":
		return nil
	default:
		return invalid("engine %q is not supported", engine)
	}
}

// checkSQLIdentifier re-applies the RPC layer's identifier rule to names
// that arrive nested inside another parameter and were never checked.
func checkSQLIdentifier(name string) error {
	if name == "" || len(name) > 63 {
		return invalid("database name must be between 1 and 63 characters")
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-':
		default:
			return invalid("database name contains an illegal character")
		}
	}
	return nil
}
