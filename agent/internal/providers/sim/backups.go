package sim

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Backups.
 *
 * A restic-shaped repository with a month of history, so retention
 * policies have something to bite on and a restore has somewhere to
 * restore from. A repository the panel has never mentioned before is
 * seeded on first contact rather than answered with an empty list: an
 * operator wiring up a new destination should see what a populated one
 * looks like.
 * ------------------------------------------------------------------ */

const seededSnapshots = 14

func (s *Sim) buildBackups() {
	s.snapshots = map[string][]providers.BackupSnapshotInfo{}
}

// snapshotsFor materialises a repository's history the first time it is
// asked for.
func (s *Sim) snapshotsForLocked(repository string) []providers.BackupSnapshotInfo {
	if existing, ok := s.snapshots[repository]; ok {
		return existing
	}

	now := time.Now().UTC()
	seed := s.seed ^ hashString(repository)
	history := make([]providers.BackupSnapshotInfo, 0, seededSnapshots)

	for i := 0; i < seededSnapshots; i++ {
		taken := now.Add(-time.Duration(i)*24*time.Hour - time.Duration(mix(seed^uint64(i))%5400)*time.Second)
		tags := []string{"nightly"}
		switch {
		case i == 0:
			tags = []string{"nightly", "latest"}
		case i%7 == 0:
			tags = []string{"weekly"}
		}
		history = append(history, providers.BackupSnapshotInfo{
			ID:        fmt.Sprintf("%016x%016x", mix(seed^uint64(i)^0xe1), mix(seed^uint64(i)^0xe2)),
			TakenAt:   stamp(taken),
			Bytes:     18*giB - int64(i)*int64(mix(seed^uint64(i)^0xe3)%uint64(512*miB)),
			FileCount: 184_000 + int(mix(seed^uint64(i)^0xe4)%22_000),
			Paths:     []string{"/etc", "/var/www", "/srv", "/home"},
			Tags:      tags,
			Verified:  i%7 == 0,
		})
	}

	s.snapshots[repository] = history
	return history
}

type simBackups struct{ *Sim }

func (s simBackups) Run(ctx context.Context, p providers.BackupRunParams, stream providers.Stream) (providers.BackupSnapshotInfo, error) {
	paths := p.Paths
	if len(paths) == 0 {
		paths = []string{"/etc", "/var/www"}
	}

	if err := progress(ctx, stream, 0, "open repository %s", p.Repository); err != nil {
		return providers.BackupSnapshotInfo{}, err
	}
	if err := progress(ctx, stream, 240*time.Millisecond, "lock repository"); err != nil {
		return providers.BackupSnapshotInfo{}, err
	}
	if err := progress(ctx, stream, 240*time.Millisecond, "load index files"); err != nil {
		return providers.BackupSnapshotInfo{}, err
	}

	var files int
	var bytes int64
	for _, target := range paths {
		cleaned, err := cleanPath(target)
		if err != nil {
			return providers.BackupSnapshotInfo{}, err
		}

		s.fs.mu.RLock()
		n, _, lookupErr := s.fs.lookup(cleaned, true)
		s.fs.mu.RUnlock()
		if lookupErr != nil {
			return providers.BackupSnapshotInfo{}, lookupErr
		}
		if excluded(cleaned, p.Exclude) {
			_ = progress(ctx, stream, 0, "skipping %s (excluded)", cleaned)
			continue
		}

		files += countNodes(n)
		bytes += treeSize(n)
		if err := progress(ctx, stream, 260*time.Millisecond, "scan %s: %d files, %d bytes", cleaned, countNodes(n), treeSize(n)); err != nil {
			return providers.BackupSnapshotInfo{}, err
		}
	}

	for _, database := range p.Databases {
		if err := progress(ctx, stream, 300*time.Millisecond, "dump %s database %q into the snapshot", database.Engine, database.Name); err != nil {
			return providers.BackupSnapshotInfo{}, err
		}
		s.mu.Lock()
		if db := s.findDatabaseLocked(database.Engine, database.Name); db != nil {
			bytes += db.SizeBytes / 8
			files++
		}
		s.mu.Unlock()
	}

	now := time.Now().UTC()
	snapshot := providers.BackupSnapshotInfo{
		ID:        fmt.Sprintf("%016x%016x", mix(s.seed^uint64(now.UnixNano())), mix(s.seed^uint64(now.UnixNano())^0x77)),
		TakenAt:   stamp(now),
		Bytes:     bytes,
		FileCount: files,
		Paths:     paths,
		Tags:      p.Tags,
	}
	if snapshot.Tags == nil {
		snapshot.Tags = []string{}
	}

	s.mu.Lock()
	history := s.snapshotsForLocked(p.Repository)
	s.snapshots[p.Repository] = append([]providers.BackupSnapshotInfo{snapshot}, history...)
	s.mu.Unlock()

	_ = progress(ctx, stream, 0, "processed %d files, %d bytes", files, bytes)
	_ = progress(ctx, stream, 0, "snapshot %s saved", snapshot.ID[:8])
	return snapshot, nil
}

func excluded(target string, patterns []string) bool {
	for _, pattern := range patterns {
		if pattern == "" {
			continue
		}
		if strings.HasPrefix(target, strings.TrimSuffix(pattern, "*")) {
			return true
		}
	}
	return false
}

func (s simBackups) List(_ context.Context, p providers.BackupListParams) ([]providers.BackupSnapshotInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	history := s.snapshotsForLocked(p.Repository)
	out := make([]providers.BackupSnapshotInfo, len(history))
	copy(out, history)
	sort.SliceStable(out, func(i, j int) bool { return out[i].TakenAt > out[j].TakenAt })
	return out, nil
}

func (s simBackups) Restore(ctx context.Context, p providers.BackupRestoreParams, stream providers.Stream) (providers.BackupRestoreResult, error) {
	target, err := cleanPath(p.Target)
	if err != nil {
		return providers.BackupRestoreResult{}, err
	}

	s.mu.Lock()
	snapshot, found := findSnapshot(s.snapshotsForLocked(p.Repository), p.SnapshotID)
	s.mu.Unlock()
	if !found {
		return providers.BackupRestoreResult{}, fmt.Errorf("snapshot %s: %w", p.SnapshotID, providers.ErrNotFound)
	}

	restoring := snapshot.Paths
	if len(p.Include) > 0 {
		restoring = p.Include
	}

	if err := progress(ctx, stream, 0, "repository %s opened successfully", p.Repository); err != nil {
		return providers.BackupRestoreResult{}, err
	}
	if err := progress(ctx, stream, 220*time.Millisecond, "restoring snapshot %s to %s", snapshot.ID[:8], target); err != nil {
		return providers.BackupRestoreResult{}, err
	}

	files := 0
	var bytes int64
	share := snapshot.FileCount / max(len(restoring), 1)

	for _, member := range restoring {
		if err := progress(ctx, stream, 280*time.Millisecond, "restoring %s", member); err != nil {
			return providers.BackupRestoreResult{}, err
		}
		files += share
		bytes += snapshot.Bytes / int64(max(len(restoring), 1))

		s.fs.mu.Lock()
		destination := target
		if target != member {
			destination = target + member
		}
		s.fs.mkdirAllLocked(destination)
		s.fs.file(destination+"/.restored-from", fmt.Sprintf("snapshot %s taken %s\n", snapshot.ID, snapshot.TakenAt))
		s.fs.mu.Unlock()
	}

	_ = progress(ctx, stream, 0, "restored %d files (%d bytes) to %s", files, bytes, target)
	return providers.BackupRestoreResult{RestoredFiles: files, Bytes: bytes}, nil
}

func findSnapshot(history []providers.BackupSnapshotInfo, id string) (providers.BackupSnapshotInfo, bool) {
	for _, snapshot := range history {
		if snapshot.ID == id || strings.HasPrefix(snapshot.ID, id) {
			return snapshot, true
		}
	}
	return providers.BackupSnapshotInfo{}, false
}

func (s simBackups) Verify(ctx context.Context, p providers.BackupVerifyParams, stream providers.Stream) (providers.BackupVerifyResult, error) {
	s.mu.Lock()
	history := s.snapshotsForLocked(p.Repository)
	index := -1
	for i, snapshot := range history {
		if snapshot.ID == p.SnapshotID || strings.HasPrefix(snapshot.ID, p.SnapshotID) {
			index = i
			break
		}
	}
	if index < 0 {
		s.mu.Unlock()
		return providers.BackupVerifyResult{}, fmt.Errorf("snapshot %s: %w", p.SnapshotID, providers.ErrNotFound)
	}
	snapshot := history[index]
	s.mu.Unlock()

	for _, step := range []string{
		"create exclusive lock for repository",
		"load indexes",
		"check all packs",
		"check snapshots, trees and blobs",
		fmt.Sprintf("read %d blobs of snapshot %s", snapshot.FileCount/40, snapshot.ID[:8]),
	} {
		if err := progress(ctx, stream, 260*time.Millisecond, "%s", step); err != nil {
			return providers.BackupVerifyResult{}, err
		}
	}

	s.mu.Lock()
	s.snapshots[p.Repository][index].Verified = true
	s.mu.Unlock()

	_ = progress(ctx, stream, 0, "no errors were found")
	return providers.BackupVerifyResult{OK: true, Errors: []string{}}, nil
}

// Prune applies the retention policy for real, newest first, so a policy
// that would delete everything visibly does.
func (s simBackups) Prune(ctx context.Context, p providers.BackupPruneParams, stream providers.Stream) (providers.BackupPruneResult, error) {
	if err := progress(ctx, stream, 0, "repository %s opened successfully", p.Repository); err != nil {
		return providers.BackupPruneResult{}, err
	}
	if err := progress(ctx, stream, 240*time.Millisecond, "applying retention policy: last=%d daily=%d weekly=%d monthly=%d",
		p.KeepLast, p.KeepDaily, p.KeepWeekly, p.KeepMonthly); err != nil {
		return providers.BackupPruneResult{}, err
	}

	s.mu.Lock()
	history := s.snapshotsForLocked(p.Repository)
	sorted := append([]providers.BackupSnapshotInfo(nil), history...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].TakenAt > sorted[j].TakenAt })

	keep := p.KeepLast + p.KeepDaily
	if p.KeepWeekly > 0 {
		keep += p.KeepWeekly
	}
	if p.KeepMonthly > 0 {
		keep += p.KeepMonthly
	}
	if keep > len(sorted) {
		keep = len(sorted)
	}

	removed := sorted[keep:]
	s.snapshots[p.Repository] = sorted[:keep]
	s.mu.Unlock()

	var reclaimed int64
	for _, snapshot := range removed {
		// Deduplication means removing a snapshot frees far less than it
		// claims to hold; reporting the full size would flatter the number.
		reclaimed += snapshot.Bytes / 12
		if err := progress(ctx, stream, 90*time.Millisecond, "remove snapshot %s", snapshot.ID[:8]); err != nil {
			return providers.BackupPruneResult{}, err
		}
	}

	_ = progress(ctx, stream, 0, "removed %d snapshots, %d bytes reclaimed", len(removed), reclaimed)
	return providers.BackupPruneResult{Removed: len(removed), ReclaimedBytes: reclaimed}, nil
}
