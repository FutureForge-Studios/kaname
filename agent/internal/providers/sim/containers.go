package sim

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Containers.
 *
 * Six of them, with the mix a small fleet actually has: a few things
 * that stay up, one that exited non-zero and one that was created and
 * never started. State changes stick and push container.changed, and
 * `container.exec` drops into the same fake shell the terminal uses,
 * rooted in the container's own tiny filesystem rather than the host's.
 * ------------------------------------------------------------------ */

type container struct {
	info        providers.ContainerInfo
	process     string
	processArgs string
	processUser string
	rssBase     int64
	memLimit    int64
	cpuBase     float64
	fs          *memfs
}

type containerSeed struct {
	name        string
	image       string
	state       string
	ageDays     int
	ports       []providers.ContainerPort
	labels      map[string]string
	networks    []string
	mounts      []providers.ContainerMount
	process     string
	processArgs string
	processUser string
	rss         int64
	memLimit    int64
	cpu         float64
	exitCode    int
	restarts    int
}

func tcp(host, guest int) providers.ContainerPort {
	return providers.ContainerPort{ContainerPort: guest, HostPort: ptr(host), HostIP: ptr("0.0.0.0"), Protocol: "tcp"}
}

var containerCatalogue = []containerSeed{
	{
		name: "kaname-redis", image: "redis:7-alpine", state: "running", ageDays: 41,
		ports:    []providers.ContainerPort{tcp(6379, 6379)},
		labels:   map[string]string{"com.docker.compose.project": "kaname", "com.docker.compose.service": "redis"},
		networks: []string{"kaname_default"},
		mounts:   []providers.ContainerMount{{Source: "/var/lib/docker/volumes/kaname_redis/_data", Destination: "/data", RW: true}},
		process:  "redis-server", processArgs: "redis-server *:6379", processUser: "systemd-network",
		rss: 38 * miB, memLimit: 512 * miB, cpu: 0.9,
	},
	{
		name: "kaname-minio", image: "minio/minio:RELEASE.2024-06-13T22-53-53Z", state: "running", ageDays: 41,
		ports:    []providers.ContainerPort{tcp(9000, 9000), tcp(9001, 9001)},
		labels:   map[string]string{"com.docker.compose.project": "kaname", "com.docker.compose.service": "minio"},
		networks: []string{"kaname_default"},
		mounts:   []providers.ContainerMount{{Source: "/srv/minio", Destination: "/data", RW: true}},
		process:  "minio", processArgs: "minio server /data --console-address :9001", processUser: "root",
		rss: 214 * miB, memLimit: 2 * giB, cpu: 2.4,
	},
	{
		name: "pgbouncer", image: "edoburu/pgbouncer:1.22.1", state: "running", ageDays: 26,
		ports:    []providers.ContainerPort{tcp(6432, 5432)},
		labels:   map[string]string{"com.docker.compose.project": "kaname", "com.docker.compose.service": "pgbouncer"},
		networks: []string{"kaname_default"},
		mounts:   []providers.ContainerMount{{Source: "/etc/pgbouncer", Destination: "/etc/pgbouncer", RW: false}},
		process:  "pgbouncer", processArgs: "/usr/sbin/pgbouncer /etc/pgbouncer/pgbouncer.ini", processUser: "postgres",
		rss: 26 * miB, memLimit: 256 * miB, cpu: 0.5,
	},
	{
		name: "uptime-kuma", image: "louislam/uptime-kuma:1.23.13", state: "running", ageDays: 63,
		ports:    []providers.ContainerPort{tcp(3001, 3001)},
		labels:   map[string]string{"maintainer": "louislam"},
		networks: []string{"bridge"},
		mounts:   []providers.ContainerMount{{Source: "/srv/uptime-kuma", Destination: "/app/data", RW: true}},
		process:  "node", processArgs: "node server/server.js", processUser: "root",
		rss: 176 * miB, memLimit: 1 * giB, cpu: 1.7, restarts: 3,
	},
	{
		name: "n8n", image: "n8nio/n8n:1.45.1", state: "exited", ageDays: 12,
		ports:    []providers.ContainerPort{tcp(5678, 5678)},
		labels:   map[string]string{"com.docker.compose.project": "automation", "com.docker.compose.service": "n8n"},
		networks: []string{"automation_default"},
		mounts:   []providers.ContainerMount{{Source: "/srv/n8n", Destination: "/home/node/.n8n", RW: true}},
		process:  "node", processArgs: "node /usr/local/bin/n8n start", processUser: "node",
		rss: 0, memLimit: 1 * giB, exitCode: 137, restarts: 2,
	},
	{
		name: "watchtower", image: "containrrr/watchtower:1.7.1", state: "created", ageDays: 3,
		labels:   map[string]string{"com.centurylinklabs.watchtower": "true"},
		networks: []string{"bridge"},
		mounts:   []providers.ContainerMount{{Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: false}},
		process:  "watchtower", processArgs: "/watchtower --cleanup --interval 3600", processUser: "root",
		memLimit: 128 * miB,
	},
}

var imageCatalogue = []struct {
	tags    []string
	size    int64
	ageDays int
	inUse   bool
}{
	{[]string{"redis:7-alpine"}, 41 * miB, 45, true},
	{[]string{"minio/minio:RELEASE.2024-06-13T22-53-53Z"}, 178 * miB, 45, true},
	{[]string{"edoburu/pgbouncer:1.22.1"}, 24 * miB, 30, true},
	{[]string{"louislam/uptime-kuma:1.23.13"}, 462 * miB, 70, true},
	{[]string{"n8nio/n8n:1.45.1"}, 703 * miB, 14, true},
	{[]string{"containrrr/watchtower:1.7.1"}, 17 * miB, 6, true},
	{[]string{"postgres:16-alpine"}, 254 * miB, 118, false},
	{[]string{"<none>:<none>"}, 512 * miB, 132, false},
	{[]string{"nginx:1.27-alpine"}, 48 * miB, 91, false},
}

func (s *Sim) buildContainers() {
	now := time.Now().UTC()

	s.containers = make([]*container, 0, len(containerCatalogue))
	for i, seed := range containerCatalogue {
		id := fmt.Sprintf("%016x%016x%016x%016x", mix(s.seed^uint64(i)^0xc1), mix(s.seed^uint64(i)^0xc2), mix(s.seed^uint64(i)^0xc3), mix(s.seed^uint64(i)^0xc4))
		created := now.Add(-time.Duration(seed.ageDays) * 24 * time.Hour)

		info := providers.ContainerInfo{
			ID:           id,
			Name:         seed.name,
			Image:        seed.image,
			ImageID:      "sha256:" + fmt.Sprintf("%016x%016x%016x%016x", mix(s.seed^uint64(i)^0xd1), mix(s.seed^uint64(i)^0xd2), mix(s.seed^uint64(i)^0xd3), mix(s.seed^uint64(i)^0xd4)),
			State:        seed.state,
			CreatedAt:    stamp(created),
			Ports:        seed.ports,
			Labels:       seed.labels,
			Networks:     seed.networks,
			Mounts:       seed.mounts,
			RestartCount: seed.restarts,
			MemoryLimit:  ptr(seed.memLimit),
			Runtime:      "docker",
		}
		if info.Ports == nil {
			info.Ports = []providers.ContainerPort{}
		}
		if info.Labels == nil {
			info.Labels = map[string]string{}
		}

		switch seed.state {
		case "running":
			started := created.Add(time.Duration(mix(s.seed^uint64(i)^0xe1)%3600) * time.Second)
			info.StartedAt = stampPtr(started)
			info.Status = "Up " + humanDuration(now.Sub(started))
		case "exited":
			stopped := now.Add(-time.Duration(2+mix(s.seed^uint64(i)^0xe2)%40) * time.Hour)
			info.StartedAt = stampPtr(created)
			info.Status = fmt.Sprintf("Exited (%d) %s ago", seed.exitCode, humanDuration(now.Sub(stopped)))
		default:
			info.Status = "Created"
		}

		s.containers = append(s.containers, &container{
			info:        info,
			process:     seed.process,
			processArgs: seed.processArgs,
			processUser: seed.processUser,
			rssBase:     seed.rss,
			memLimit:    seed.memLimit,
			cpuBase:     seed.cpu,
		})
	}

	s.images = make([]providers.ImageInfo, 0, len(imageCatalogue))
	for i, seed := range imageCatalogue {
		s.images = append(s.images, providers.ImageInfo{
			ID:        "sha256:" + fmt.Sprintf("%016x%016x%016x%016x", mix(s.seed^uint64(i)^0xf1), mix(s.seed^uint64(i)^0xf2), mix(s.seed^uint64(i)^0xf3), mix(s.seed^uint64(i)^0xf4)),
			Tags:      seed.tags,
			Size:      seed.size,
			CreatedAt: stamp(now.Add(-time.Duration(seed.ageDays) * 24 * time.Hour)),
			InUse:     seed.inUse,
		})
	}
}

func humanDuration(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%d seconds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%d minutes", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d hours", int(d.Hours()))
	default:
		return fmt.Sprintf("%d days", int(d.Hours()/24))
	}
}

/* ----------------------------- containers ---------------------------- */

type simContainers struct{ *Sim }

func (s *Sim) findContainerLocked(id string) *container {
	for _, c := range s.containers {
		if c.info.ID == id || c.info.Name == id || strings.HasPrefix(c.info.ID, id) {
			return c
		}
	}
	return nil
}

// withStats fills the two columns that only mean anything while the
// container is up.
func (s *Sim) withStats(c *container, now time.Time) providers.ContainerInfo {
	info := c.info
	if info.State != "running" {
		return info
	}

	t := float64(now.UnixMilli()) / 1000
	seed := s.seed ^ hashString(c.info.ID)
	info.CPUPercent = ptr(round2(clampf(c.cpuBase*(1+1.6*drift(seed, t/40, 2)), 0, 100)))
	info.MemoryUsage = ptr(int64(float64(c.rssBase) * (1 + 0.14*drift(seed^0x3, t/300, 2))))
	return info
}

func (s simContainers) List(_ context.Context, p providers.ContainerListParams) ([]providers.ContainerInfo, error) {
	now := time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.ContainerInfo, 0, len(s.containers))
	for _, c := range s.containers {
		if !p.All && c.info.State != "running" {
			continue
		}
		if p.WithStats {
			out = append(out, s.withStats(c, now))
			continue
		}
		out = append(out, c.info)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s simContainers) Inspect(_ context.Context, id string) (providers.ContainerInspectResult, error) {
	now := time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()

	c := s.findContainerLocked(id)
	if c == nil {
		return providers.ContainerInspectResult{}, fmt.Errorf("container %s: %w", id, providers.ErrNotFound)
	}

	info := s.withStats(c, now)
	raw, err := json.Marshal(map[string]any{
		"Id":      info.ID,
		"Name":    "/" + info.Name,
		"Created": info.CreatedAt,
		"Path":    strings.Fields(c.processArgs)[0],
		"Args":    strings.Fields(c.processArgs)[1:],
		"State": map[string]any{
			"Status":       info.State,
			"Running":      info.State == "running",
			"Pid":          0,
			"StartedAt":    info.StartedAt,
			"RestartCount": info.RestartCount,
		},
		"Image": info.ImageID,
		"Config": map[string]any{
			"Hostname": info.ID[:12],
			"Image":    info.Image,
			"Labels":   info.Labels,
			"Env":      []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
		},
		"HostConfig": map[string]any{
			"RestartPolicy": map[string]any{"Name": "unless-stopped"},
			"Memory":        c.memLimit,
			"NetworkMode":   info.Networks[0],
		},
		"Mounts": info.Mounts,
	})
	if err != nil {
		return providers.ContainerInspectResult{}, fmt.Errorf("render inspect payload: %w", err)
	}

	return providers.ContainerInspectResult{Container: info, Raw: raw}, nil
}

func (s simContainers) Start(_ context.Context, id string) (providers.ContainerInfo, error) {
	return s.setContainerState(id, "running")
}

func (s simContainers) Stop(_ context.Context, p providers.ContainerStopParams) (providers.ContainerInfo, error) {
	return s.setContainerState(p.ID, "exited")
}

func (s simContainers) Restart(_ context.Context, p providers.ContainerStopParams) (providers.ContainerInfo, error) {
	if _, err := s.setContainerState(p.ID, "exited"); err != nil {
		return providers.ContainerInfo{}, err
	}
	info, err := s.setContainerState(p.ID, "running")
	if err != nil {
		return providers.ContainerInfo{}, err
	}

	s.mu.Lock()
	if c := s.findContainerLocked(p.ID); c != nil {
		c.info.RestartCount++
		info = c.info
	}
	s.mu.Unlock()
	return info, nil
}

// setContainerState is where the statefulness lives: the container's
// shim and main process join or leave the host process table with it.
func (s *Sim) setContainerState(id, state string) (providers.ContainerInfo, error) {
	now := time.Now().UTC()

	s.mu.Lock()
	c := s.findContainerLocked(id)
	if c == nil {
		s.mu.Unlock()
		return providers.ContainerInfo{}, fmt.Errorf("container %s: %w", id, providers.ErrNotFound)
	}
	if c.info.State == state {
		info := c.info
		s.mu.Unlock()
		return info, nil
	}

	c.info.State = state
	switch state {
	case "running":
		c.info.StartedAt = stampPtr(now)
		c.info.Status = "Up 1 seconds"
	case "exited":
		c.info.Status = "Exited (0) 0 seconds ago"
		c.info.CPUPercent = nil
		c.info.MemoryUsage = nil
	}
	s.respawnContainerdLocked()
	info := c.info
	s.mu.Unlock()

	s.emit(topicContainerChanged, map[string]any{"container_id": info.ID, "name": info.Name, "state": info.State})
	return info, nil
}

// respawnContainerdLocked rebuilds containerd's process set so the host
// process table always agrees with the container table.
func (s *Sim) respawnContainerdLocked() {
	u := s.findUnitLocked("containerd.service")
	if u == nil || u.info.ActiveState != "active" {
		return
	}
	s.bringDownLocked(u, "inactive", "dead")
	s.bringUpLocked(u, time.Now().UTC())
}

func (s simContainers) Remove(_ context.Context, p providers.ContainerRemoveParams) error {
	s.mu.Lock()

	index := -1
	for i, c := range s.containers {
		if c.info.ID == p.ID || c.info.Name == p.ID || strings.HasPrefix(c.info.ID, p.ID) {
			index = i
			break
		}
	}
	if index < 0 {
		s.mu.Unlock()
		return fmt.Errorf("container %s: %w", p.ID, providers.ErrNotFound)
	}
	target := s.containers[index]
	if target.info.State == "running" && !p.Force {
		s.mu.Unlock()
		return fmt.Errorf("container %s is running: %w", target.info.Name, providers.ErrConflict)
	}

	id := target.info.ID
	name := target.info.Name
	s.containers = append(s.containers[:index], s.containers[index+1:]...)
	s.respawnContainerdLocked()
	s.mu.Unlock()

	s.emit(topicContainerChanged, map[string]any{"container_id": id, "name": name, "state": "removed"})
	return nil
}

func (s simContainers) Logs(ctx context.Context, p providers.ContainerLogsParams, stream providers.Stream) ([]providers.LogRecord, error) {
	s.mu.Lock()
	c := s.findContainerLocked(p.ID)
	if c == nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("container %s: %w", p.ID, providers.ErrNotFound)
	}
	name := c.info.Name
	s.mu.Unlock()

	return s.tail(ctx, stream, tailRequest{
		source:    sourceContainer,
		container: name,
		lines:     p.Lines,
		follow:    p.Follow,
		since:     p.Since,
	})
}

func (s simContainers) Exec(ctx context.Context, p providers.ContainerExecParams, stream providers.Stream) error {
	s.mu.Lock()
	c := s.findContainerLocked(p.ID)
	if c == nil {
		s.mu.Unlock()
		return fmt.Errorf("container %s: %w", p.ID, providers.ErrNotFound)
	}
	if c.info.State != "running" {
		name := c.info.Name
		s.mu.Unlock()
		return fmt.Errorf("container %s is not running: %w", name, providers.ErrPreconditionFailed)
	}
	if c.fs == nil {
		c.fs = buildContainerFilesystem(s.Sim, c)
	}
	shellFS, prompt := c.fs, fmt.Sprintf("root@%s", c.info.ID[:12])
	s.mu.Unlock()

	session := newPtySession(s.Sim, shellFS, prompt, "/", p.Cols, p.Rows)
	_, err := session.run(ctx, stream)
	return err
}

func (s simContainers) Images(context.Context) ([]providers.ImageInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.ImageInfo, len(s.images))
	copy(out, s.images)
	return out, nil
}

func (s simContainers) Prune(_ context.Context, p providers.ContainerPruneParams) (providers.ContainerPruneResult, error) {
	s.mu.Lock()

	removed := []string{}
	var reclaimed int64

	kept := s.containers[:0]
	for _, c := range s.containers {
		if c.info.State == "exited" {
			removed = append(removed, c.info.ID)
			reclaimed += c.rssBase + 64*miB
			continue
		}
		kept = append(kept, c)
	}
	s.containers = kept

	if p.IncludeImages {
		keptImages := s.images[:0]
		for _, image := range s.images {
			if !image.InUse {
				removed = append(removed, image.ID)
				reclaimed += image.Size
				continue
			}
			keptImages = append(keptImages, image)
		}
		s.images = keptImages
	}
	if p.IncludeVolumes {
		reclaimed += 1_284_374_528
		removed = append(removed, "kaname_redis_stale", "automation_n8n_old")
	}

	s.respawnContainerdLocked()
	s.mu.Unlock()

	return providers.ContainerPruneResult{ReclaimedBytes: reclaimed, Removed: removed}, nil
}
