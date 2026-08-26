//go:build linux

package linux

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Containers.
 *
 * The Engine API is spoken directly over the local unix socket with
 * net/http and a unix dialer, rather than by importing the Docker client
 * module: the handful of endpoints below are stable, and the alternative
 * drags a very large dependency tree into a binary whose whole pitch is
 * that it is small and auditable.
 *
 * The socket is reached only from here. It is never exposed over the
 * network — a reachable container socket is a root shell, and not
 * exposing it is the entire reason this agent exists.
 * ------------------------------------------------------------------ */

const (
	// v1.40 is the newest version every supported Docker (20.10+) and
	// Podman compatibility socket both accept.
	dockerAPIPrefix = "/v1.40"
	// The daemon ignores Host on a unix socket, but net/http insists on one.
	dockerHost = "http://kaname"

	dockerCallTimeout = 30 * time.Second
)

var dockerSockets = []struct {
	path    string
	runtime string
}{
	{"/var/run/docker.sock", providers.CapDocker},
	{"/run/docker.sock", providers.CapDocker},
	{"/run/podman/podman.sock", providers.CapPodman},
	{"/var/run/podman/podman.sock", providers.CapPodman},
}

type dockerClient struct {
	socket  string
	runtime string
	http    *http.Client
}

// discoverContainerRuntime prefers Docker and falls back to Podman's
// compatibility socket, which speaks the same API.
func discoverContainerRuntime(ctx context.Context) *dockerClient {
	for _, candidate := range dockerSockets {
		info, err := os.Stat(candidate.path)
		if err != nil || info.Mode()&os.ModeSocket == 0 {
			continue
		}

		client := newDockerClient(candidate.path, candidate.runtime)
		probe, cancel := context.WithTimeout(ctx, 3*time.Second)
		err = client.get(probe, "/_ping", nil)
		cancel()
		if err != nil {
			continue
		}
		return client
	}
	return nil
}

func newDockerClient(socket, runtime string) *dockerClient {
	dialer := &net.Dialer{}
	return &dockerClient{
		socket:  socket,
		runtime: runtime,
		http: &http.Client{
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					return dialer.DialContext(ctx, "unix", socket)
				},
				DisableCompression: true,
			},
		},
	}
}

/* --------------------------- wire structures -------------------------- */

type dockerPort struct {
	IP          string `json:"IP"`
	PrivatePort int    `json:"PrivatePort"`
	PublicPort  int    `json:"PublicPort"`
	Type        string `json:"Type"`
}

type dockerMount struct {
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
	RW          bool   `json:"RW"`
}

type dockerContainer struct {
	ID              string            `json:"Id"`
	Names           []string          `json:"Names"`
	Image           string            `json:"Image"`
	ImageID         string            `json:"ImageID"`
	Created         int64             `json:"Created"`
	State           string            `json:"State"`
	Status          string            `json:"Status"`
	Ports           []dockerPort      `json:"Ports"`
	Labels          map[string]string `json:"Labels"`
	Mounts          []dockerMount     `json:"Mounts"`
	NetworkSettings struct {
		Networks map[string]struct{} `json:"Networks"`
	} `json:"NetworkSettings"`
}

type dockerInspect struct {
	ID      string `json:"Id"`
	Name    string `json:"Name"`
	Created string `json:"Created"`
	Image   string `json:"Image"`
	State   struct {
		Status    string `json:"Status"`
		StartedAt string `json:"StartedAt"`
	} `json:"State"`
	RestartCount int `json:"RestartCount"`
	Config       struct {
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
		Tty    bool              `json:"Tty"`
	} `json:"Config"`
	HostConfig struct {
		Memory int64 `json:"Memory"`
	} `json:"HostConfig"`
	NetworkSettings struct {
		Ports    map[string][]struct{ HostIp, HostPort string } `json:"Ports"`
		Networks map[string]struct{}                            `json:"Networks"`
	} `json:"NetworkSettings"`
	Mounts []dockerMount `json:"Mounts"`
}

type dockerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PerCPUUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     int    `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
}

type dockerImage struct {
	ID         string   `json:"Id"`
	RepoTags   []string `json:"RepoTags"`
	Size       int64    `json:"Size"`
	Created    int64    `json:"Created"`
	Containers int      `json:"Containers"`
}

type dockerEvent struct {
	Type   string `json:"Type"`
	Action string `json:"Action"`
	Actor  struct {
		ID string `json:"ID"`
	} `json:"Actor"`
}

/* ------------------------------ transport ---------------------------- */

func (c *dockerClient) get(ctx context.Context, path string, out any) error {
	return c.call(ctx, http.MethodGet, path, nil, out)
}

func (c *dockerClient) post(ctx context.Context, path string, body, out any) error {
	return c.call(ctx, http.MethodPost, path, body, out)
}

func (c *dockerClient) call(ctx context.Context, method, path string, body, out any) error {
	resp, err := c.open(ctx, method, path, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("decode %s %s: %w", method, path, err)
	}
	return nil
}

// open performs the request and maps the daemon's own error shape onto
// the provider sentinels, so "no such container" reaches the panel as
// not_found rather than as an opaque exec failure.
func (c *dockerClient) open(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("encode %s body: %w", path, err)
		}
		payload = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, dockerHost+dockerAPIPrefix+path, payload)
	if err != nil {
		return nil, fmt.Errorf("build %s %s: %w", method, path, err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s %s on %s: %w", method, path, c.socket, err)
	}
	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return nil, dockerError(resp.StatusCode, raw)
	}
	return resp, nil
}

func dockerError(status int, raw []byte) error {
	var envelope struct {
		Message string `json:"message"`
	}
	message := strings.TrimSpace(string(raw))
	if err := json.Unmarshal(raw, &envelope); err == nil && envelope.Message != "" {
		message = envelope.Message
	}

	switch status {
	case http.StatusNotFound:
		return notFound("%s", message)
	case http.StatusConflict:
		return fmt.Errorf("%s: %w", message, providers.ErrConflict)
	case http.StatusForbidden, http.StatusUnauthorized:
		return fmt.Errorf("%s: %w", message, providers.ErrPermissionDenied)
	case http.StatusNotImplemented:
		return unsupported("%s", message)
	default:
		return &providers.ExecError{Op: "container runtime", Output: message, Err: fmt.Errorf("http %d", status)}
	}
}

// hijack upgrades a request to a raw bidirectional stream, which is how
// the Engine API carries an interactive exec.
func (c *dockerClient) hijack(ctx context.Context, path string, body any) (net.Conn, *bufio.Reader, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, nil, fmt.Errorf("encode %s body: %w", path, err)
	}

	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", c.socket)
	if err != nil {
		return nil, nil, fmt.Errorf("dial %s: %w", c.socket, err)
	}

	req, err := http.NewRequest(http.MethodPost, dockerHost+dockerAPIPrefix+path, bytes.NewReader(encoded))
	if err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("build %s: %w", path, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "tcp")

	if err := req.Write(conn); err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("send %s: %w", path, err)
	}

	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, req)
	if err != nil {
		conn.Close()
		return nil, nil, fmt.Errorf("read %s response: %w", path, err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols && resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		conn.Close()
		return nil, nil, dockerError(resp.StatusCode, raw)
	}
	return conn, reader, nil
}

// watchEvents relays container state changes so the control plane's
// cached container table does not have to be polled (KD-012).
func (c *dockerClient) watchEvents(ctx context.Context, emit func(topic string, data any)) {
	filters := url.QueryEscape(`{"type":["container"]}`)

	for ctx.Err() == nil {
		resp, err := c.open(ctx, http.MethodGet, "/events?filters="+filters, nil)
		if err != nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(15 * time.Second):
			}
			continue
		}

		decoder := json.NewDecoder(resp.Body)
		for {
			var event dockerEvent
			if err := decoder.Decode(&event); err != nil {
				break
			}
			if event.Type != "container" || event.Actor.ID == "" {
				continue
			}
			switch event.Action {
			case "start", "stop", "die", "kill", "pause", "unpause", "restart", "destroy", "health_status":
			default:
				continue
			}

			lookup, cancel := context.WithTimeout(ctx, dockerCallTimeout)
			info, err := c.inspect(lookup, event.Actor.ID)
			cancel()
			if err != nil {
				continue
			}
			emit(topicContainerChanged, info)
		}
		resp.Body.Close()
	}
}

/* ------------------------------ operations --------------------------- */

type containerOps struct{ p *provider }

func (o containerOps) client() (*dockerClient, error) {
	if o.p.docker == nil {
		return nil, unsupported("no container runtime socket on this host")
	}
	return o.p.docker, nil
}

func (o containerOps) List(ctx context.Context, p providers.ContainerListParams) ([]providers.ContainerInfo, error) {
	client, err := o.client()
	if err != nil {
		return nil, err
	}

	var raw []dockerContainer
	if err := client.get(ctx, "/containers/json?all="+boolParam(p.All), &raw); err != nil {
		return nil, err
	}

	containers := make([]providers.ContainerInfo, 0, len(raw))
	for _, entry := range raw {
		info := client.fromList(entry)
		if p.WithStats && info.State == "running" {
			if cpu, memory, limit, err := client.stats(ctx, entry.ID); err == nil {
				info.CPUPercent, info.MemoryUsage, info.MemoryLimit = &cpu, &memory, &limit
			}
		}
		containers = append(containers, info)
	}
	sortSlice(containers, func(a, b providers.ContainerInfo) bool { return a.Name < b.Name })
	return containers, nil
}

func (o containerOps) Inspect(ctx context.Context, id string) (providers.ContainerInspectResult, error) {
	client, err := o.client()
	if err != nil {
		return providers.ContainerInspectResult{}, err
	}

	resp, err := client.open(ctx, http.MethodGet, "/containers/"+url.PathEscape(id)+"/json", nil)
	if err != nil {
		return providers.ContainerInspectResult{}, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return providers.ContainerInspectResult{}, fmt.Errorf("read inspect body: %w", err)
	}

	var parsed dockerInspect
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return providers.ContainerInspectResult{}, fmt.Errorf("decode inspect body: %w", err)
	}
	return providers.ContainerInspectResult{Container: client.fromInspect(parsed), Raw: json.RawMessage(raw)}, nil
}

func (o containerOps) Start(ctx context.Context, id string) (providers.ContainerInfo, error) {
	client, err := o.client()
	if err != nil {
		return providers.ContainerInfo{}, err
	}
	if err := client.post(ctx, "/containers/"+url.PathEscape(id)+"/start", nil, nil); err != nil {
		return providers.ContainerInfo{}, err
	}
	return client.inspect(ctx, id)
}

func (o containerOps) Stop(ctx context.Context, p providers.ContainerStopParams) (providers.ContainerInfo, error) {
	client, err := o.client()
	if err != nil {
		return providers.ContainerInfo{}, err
	}
	path := "/containers/" + url.PathEscape(p.ID) + "/stop?t=" + strconv.Itoa(p.TimeoutSeconds)
	if err := client.post(ctx, path, nil, nil); err != nil {
		return providers.ContainerInfo{}, err
	}
	return client.inspect(ctx, p.ID)
}

func (o containerOps) Restart(ctx context.Context, p providers.ContainerStopParams) (providers.ContainerInfo, error) {
	client, err := o.client()
	if err != nil {
		return providers.ContainerInfo{}, err
	}
	path := "/containers/" + url.PathEscape(p.ID) + "/restart?t=" + strconv.Itoa(p.TimeoutSeconds)
	if err := client.post(ctx, path, nil, nil); err != nil {
		return providers.ContainerInfo{}, err
	}
	return client.inspect(ctx, p.ID)
}

func (o containerOps) Remove(ctx context.Context, p providers.ContainerRemoveParams) error {
	client, err := o.client()
	if err != nil {
		return err
	}
	path := fmt.Sprintf("/containers/%s?force=%s&v=%s",
		url.PathEscape(p.ID), boolParam(p.Force), boolParam(p.RemoveVolumes))
	return client.call(ctx, http.MethodDelete, path, nil, nil)
}

func (o containerOps) Logs(ctx context.Context, p providers.ContainerLogsParams, stream providers.Stream) ([]providers.LogRecord, error) {
	client, err := o.client()
	if err != nil {
		return nil, err
	}

	// A container started with a TTY produces a raw stream; without one
	// the daemon frames stdout and stderr, and reading it as raw text
	// would leave the 8-byte headers in the operator's log view.
	tty := false
	if info, err := client.inspectRaw(ctx, p.ID); err == nil {
		tty = info.Config.Tty
	}

	lines := p.Lines
	if lines <= 0 {
		lines = 200
	}

	query := url.Values{}
	query.Set("stdout", "1")
	query.Set("stderr", "1")
	query.Set("timestamps", "1")
	query.Set("tail", strconv.Itoa(lines))
	query.Set("follow", boolParam(p.Follow))
	if p.Since != "" {
		since, err := parseSince(p.Since)
		if err != nil {
			return nil, err
		}
		query.Set("since", strconv.FormatInt(since.Unix(), 10))
	}

	resp, err := client.open(ctx, http.MethodGet, "/containers/"+url.PathEscape(p.ID)+"/logs?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	source := "container:" + p.ID
	backlog := make([]providers.LogRecord, 0, lines)
	emit := func(line string) error {
		record := containerLogRecord(source, line)
		if len(backlog) < lines {
			backlog = append(backlog, record)
			return nil
		}
		if !p.Follow || stream == nil {
			return nil
		}
		return sendRecord(ctx, stream, record)
	}

	if tty {
		err = scanLines(ctx, resp.Body, emit)
	} else {
		err = demultiplex(ctx, resp.Body, emit)
	}
	if err != nil && !errors.Is(err, io.EOF) && ctx.Err() == nil {
		return backlog, err
	}
	return backlog, nil
}

func (o containerOps) Exec(ctx context.Context, p providers.ContainerExecParams, stream providers.Stream) error {
	client, err := o.client()
	if err != nil {
		return err
	}

	var created struct {
		ID string `json:"Id"`
	}
	// The command is a fixed argv, not a string: container.exec gives an
	// operator a shell inside the container, it does not let the caller
	// choose an arbitrary command line from the wire.
	body := map[string]any{
		"AttachStdin":  true,
		"AttachStdout": true,
		"AttachStderr": true,
		"Tty":          true,
		"Cmd":          []string{"/bin/sh"},
		"Env":          []string{"TERM=xterm-256color"},
	}
	if err := client.post(ctx, "/containers/"+url.PathEscape(p.ID)+"/exec", body, &created); err != nil {
		return err
	}
	if created.ID == "" {
		return fmt.Errorf("container runtime returned no exec id: %w", providers.ErrConflict)
	}

	conn, reader, err := client.hijack(ctx, "/exec/"+url.PathEscape(created.ID)+"/start",
		map[string]any{"Detach": false, "Tty": true})
	if err != nil {
		return err
	}
	defer conn.Close()

	// The daemon only accepts a resize once the exec is running, and the
	// hijack response is what says it is.
	if err := client.resizeExec(ctx, created.ID, p.Cols, p.Rows); err != nil {
		o.p.log.Debug("exec resize refused", "container", p.ID, "error", err)
	}

	return pumpStream(ctx, stream, reader, conn)
}

func (o containerOps) Images(ctx context.Context) ([]providers.ImageInfo, error) {
	client, err := o.client()
	if err != nil {
		return nil, err
	}

	var raw []dockerImage
	if err := client.get(ctx, "/images/json", &raw); err != nil {
		return nil, err
	}

	// The daemon only fills `Containers` when asked for shared sizes, so
	// usage is derived from the container table instead.
	used := map[string]struct{}{}
	var containers []dockerContainer
	if err := client.get(ctx, "/containers/json?all=1", &containers); err == nil {
		for _, container := range containers {
			used[container.ImageID] = struct{}{}
		}
	}

	images := make([]providers.ImageInfo, 0, len(raw))
	for _, entry := range raw {
		tags := entry.RepoTags
		if tags == nil {
			tags = []string{}
		}
		_, inUse := used[entry.ID]
		images = append(images, providers.ImageInfo{
			ID:        entry.ID,
			Tags:      tags,
			Size:      entry.Size,
			CreatedAt: rfc3339(time.Unix(entry.Created, 0)),
			InUse:     inUse || entry.Containers > 0,
		})
	}
	sortSlice(images, func(a, b providers.ImageInfo) bool { return a.CreatedAt > b.CreatedAt })
	return images, nil
}

func (o containerOps) Prune(ctx context.Context, p providers.ContainerPruneParams) (providers.ContainerPruneResult, error) {
	result := providers.ContainerPruneResult{Removed: []string{}}

	client, err := o.client()
	if err != nil {
		return result, err
	}

	var containers struct {
		ContainersDeleted []string `json:"ContainersDeleted"`
		SpaceReclaimed    int64    `json:"SpaceReclaimed"`
	}
	if err := client.post(ctx, "/containers/prune", nil, &containers); err != nil {
		return result, err
	}
	result.Removed = append(result.Removed, containers.ContainersDeleted...)
	result.ReclaimedBytes += containers.SpaceReclaimed

	if p.IncludeImages {
		var images struct {
			ImagesDeleted []struct {
				Deleted  string `json:"Deleted"`
				Untagged string `json:"Untagged"`
			} `json:"ImagesDeleted"`
			SpaceReclaimed int64 `json:"SpaceReclaimed"`
		}
		if err := client.post(ctx, "/images/prune", nil, &images); err != nil {
			return result, err
		}
		for _, image := range images.ImagesDeleted {
			if image.Deleted != "" {
				result.Removed = append(result.Removed, image.Deleted)
			}
		}
		result.ReclaimedBytes += images.SpaceReclaimed
	}

	if p.IncludeVolumes {
		var volumes struct {
			VolumesDeleted []string `json:"VolumesDeleted"`
			SpaceReclaimed int64    `json:"SpaceReclaimed"`
		}
		if err := client.post(ctx, "/volumes/prune", nil, &volumes); err != nil {
			return result, err
		}
		result.Removed = append(result.Removed, volumes.VolumesDeleted...)
		result.ReclaimedBytes += volumes.SpaceReclaimed
	}
	return result, nil
}

/* ------------------------------- mapping ----------------------------- */

func (c *dockerClient) inspect(ctx context.Context, id string) (providers.ContainerInfo, error) {
	parsed, err := c.inspectRaw(ctx, id)
	if err != nil {
		return providers.ContainerInfo{}, err
	}
	return c.fromInspect(parsed), nil
}

func (c *dockerClient) inspectRaw(ctx context.Context, id string) (dockerInspect, error) {
	var parsed dockerInspect
	if err := c.get(ctx, "/containers/"+url.PathEscape(id)+"/json", &parsed); err != nil {
		return parsed, err
	}
	return parsed, nil
}

func (c *dockerClient) fromList(entry dockerContainer) providers.ContainerInfo {
	ports := make([]providers.ContainerPort, 0, len(entry.Ports))
	for _, port := range entry.Ports {
		mapped := providers.ContainerPort{ContainerPort: port.PrivatePort, Protocol: normalizeProtocol(port.Type)}
		if port.PublicPort > 0 {
			public := port.PublicPort
			mapped.HostPort = &public
			mapped.HostIP = stringPtr(port.IP)
		}
		ports = append(ports, mapped)
	}

	return providers.ContainerInfo{
		ID:        entry.ID,
		Name:      containerName(entry.Names),
		Image:     entry.Image,
		ImageID:   entry.ImageID,
		State:     containerState(entry.State),
		Status:    entry.Status,
		CreatedAt: rfc3339(time.Unix(entry.Created, 0)),
		Ports:     ports,
		Labels:    orEmptyLabels(entry.Labels),
		Networks:  networkNames(entry.NetworkSettings.Networks),
		Mounts:    mounts(entry.Mounts),
		Runtime:   c.runtime,
	}
}

func (c *dockerClient) fromInspect(parsed dockerInspect) providers.ContainerInfo {
	ports := make([]providers.ContainerPort, 0, len(parsed.NetworkSettings.Ports))
	for spec, bindings := range parsed.NetworkSettings.Ports {
		number, protocol := splitPortSpec(spec)
		if number == 0 {
			continue
		}
		if len(bindings) == 0 {
			ports = append(ports, providers.ContainerPort{ContainerPort: number, Protocol: protocol})
			continue
		}
		for _, binding := range bindings {
			mapped := providers.ContainerPort{ContainerPort: number, Protocol: protocol}
			if host, err := strconv.Atoi(binding.HostPort); err == nil {
				mapped.HostPort = &host
				mapped.HostIP = stringPtr(binding.HostIp)
			}
			ports = append(ports, mapped)
		}
	}
	sortSlice(ports, func(a, b providers.ContainerPort) bool { return a.ContainerPort < b.ContainerPort })

	info := providers.ContainerInfo{
		ID:           parsed.ID,
		Name:         strings.TrimPrefix(parsed.Name, "/"),
		Image:        parsed.Config.Image,
		ImageID:      parsed.Image,
		State:        containerState(parsed.State.Status),
		Status:       parsed.State.Status,
		CreatedAt:    normalizeTimestamp(parsed.Created),
		Ports:        ports,
		Labels:       orEmptyLabels(parsed.Config.Labels),
		Networks:     networkNames(parsed.NetworkSettings.Networks),
		Mounts:       mounts(parsed.Mounts),
		RestartCount: parsed.RestartCount,
		Runtime:      c.runtime,
	}
	if started := normalizeTimestamp(parsed.State.StartedAt); started != "" && !strings.HasPrefix(parsed.State.StartedAt, "0001-") {
		info.StartedAt = stringPtr(started)
	}
	if parsed.HostConfig.Memory > 0 {
		info.MemoryLimit = int64Ptr(parsed.HostConfig.Memory)
	}
	return info
}

// stats takes one non-streaming sample and turns the two cumulative
// readings the daemon returns into a percentage.
func (c *dockerClient) stats(ctx context.Context, id string) (float64, int64, int64, error) {
	sample, cancel := context.WithTimeout(ctx, dockerCallTimeout)
	defer cancel()

	var parsed dockerStats
	if err := c.get(sample, "/containers/"+url.PathEscape(id)+"/stats?stream=false", &parsed); err != nil {
		return 0, 0, 0, err
	}

	cpuDelta := float64(parsed.CPUStats.CPUUsage.TotalUsage) - float64(parsed.PreCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(parsed.CPUStats.SystemCPUUsage) - float64(parsed.PreCPUStats.SystemCPUUsage)
	cores := parsed.CPUStats.OnlineCPUs
	if cores == 0 {
		cores = len(parsed.CPUStats.CPUUsage.PerCPUUsage)
	}

	percent := 0.0
	if cpuDelta > 0 && systemDelta > 0 && cores > 0 {
		percent = clampPercent(cpuDelta / systemDelta * float64(cores) * 100)
	}

	// The kernel counts page cache as container memory; subtracting it is
	// what makes the figure match what an operator sees in `docker stats`.
	usage := parsed.MemoryStats.Usage
	if cache, ok := parsed.MemoryStats.Stats["inactive_file"]; ok && cache < usage {
		usage -= cache
	} else if cache, ok := parsed.MemoryStats.Stats["cache"]; ok && cache < usage {
		usage -= cache
	}
	return percent, int64(usage), int64(parsed.MemoryStats.Limit), nil
}

func (c *dockerClient) resizeExec(ctx context.Context, execID string, cols, rows int) error {
	path := fmt.Sprintf("/exec/%s/resize?h=%d&w=%d", url.PathEscape(execID), rows, cols)
	return c.post(ctx, path, nil, nil)
}

/* ------------------------------- streams ----------------------------- */

// demultiplex decodes the daemon's framed log stream: an 8-byte header
// carrying the stream id and payload length, then the payload.
func demultiplex(ctx context.Context, r io.Reader, emit func(string) error) error {
	header := make([]byte, 8)
	reader := bufio.NewReaderSize(r, 64<<10)

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if _, err := io.ReadFull(reader, header); err != nil {
			return err
		}
		size := int(binary.BigEndian.Uint32(header[4:8]))
		if size <= 0 {
			continue
		}
		if size > maxContainerFrame {
			return fmt.Errorf("container log frame of %d bytes exceeds the cap: %w", size, providers.ErrPreconditionFailed)
		}

		payload := make([]byte, size)
		if _, err := io.ReadFull(reader, payload); err != nil {
			return err
		}
		for _, line := range splitLines(string(payload)) {
			if err := emit(line); err != nil {
				return err
			}
		}
	}
}

// maxContainerFrame bounds a single log frame so a malformed header
// cannot make the agent allocate an arbitrary buffer.
const maxContainerFrame = 8 << 20

func scanLines(ctx context.Context, r io.Reader, emit func(string) error) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64<<10), maxContainerFrame)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := emit(scanner.Text()); err != nil {
			return err
		}
	}
	return scanner.Err()
}

// pumpStream wires a hijacked connection to the RPC stream in both
// directions and tears both down as soon as either side ends.
func pumpStream(ctx context.Context, stream providers.Stream, reader io.Reader, conn net.Conn) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var once sync.Once
	failure := make(chan error, 2)
	report := func(err error) { once.Do(func() { failure <- err }) }

	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	go func() {
		buffer := make([]byte, 32<<10)
		for {
			n, err := reader.Read(buffer)
			if n > 0 {
				if sendErr := stream.Send(ctx, buffer[:n], providers.EncodingBase64); sendErr != nil {
					report(sendErr)
					return
				}
			}
			if err != nil {
				report(nil)
				return
			}
		}
	}()

	go func() {
		for {
			data, err := stream.Recv(ctx)
			if err != nil {
				report(nil)
				return
			}
			if _, err := conn.Write(data); err != nil {
				report(err)
				return
			}
		}
	}()

	select {
	case err := <-failure:
		return err
	case <-ctx.Done():
		return nil
	}
}

/* ------------------------------- helpers ----------------------------- */

func containerLogRecord(source, line string) providers.LogRecord {
	// `timestamps=1` prefixes every line with an RFC3339Nano stamp.
	ts, message, ok := strings.Cut(line, " ")
	if !ok {
		return providers.LogRecord{Ts: nowRFC3339(), Level: "info", Source: source, Message: line}
	}
	parsed, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return providers.LogRecord{Ts: nowRFC3339(), Level: "info", Source: source, Message: line}
	}
	return providers.LogRecord{Ts: rfc3339(parsed), Level: guessLevel(message), Source: source, Message: message}
}

func containerName(names []string) string {
	if len(names) == 0 {
		return ""
	}
	return strings.TrimPrefix(names[0], "/")
}

func containerState(state string) string {
	switch state {
	case "created", "running", "paused", "restarting", "removing", "exited", "dead":
		return state
	default:
		return "unknown"
	}
}

func normalizeProtocol(protocol string) string {
	if protocol == "udp" {
		return "udp"
	}
	return "tcp"
}

func splitPortSpec(spec string) (int, string) {
	number, protocol, ok := strings.Cut(spec, "/")
	parsed, err := strconv.Atoi(number)
	if err != nil {
		return 0, "tcp"
	}
	if !ok {
		return parsed, "tcp"
	}
	return parsed, normalizeProtocol(protocol)
}

func networkNames(networks map[string]struct{}) []string {
	names := make([]string, 0, len(networks))
	for name := range networks {
		names = append(names, name)
	}
	sortSlice(names, func(a, b string) bool { return a < b })
	return names
}

func mounts(entries []dockerMount) []providers.ContainerMount {
	out := make([]providers.ContainerMount, 0, len(entries))
	for _, entry := range entries {
		out = append(out, providers.ContainerMount{Source: entry.Source, Destination: entry.Destination, RW: entry.RW})
	}
	return out
}

func orEmptyLabels(labels map[string]string) map[string]string {
	if labels == nil {
		return map[string]string{}
	}
	return labels
}

func normalizeTimestamp(value string) string {
	if value == "" {
		return ""
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return value
	}
	return rfc3339(parsed)
}

func boolParam(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
