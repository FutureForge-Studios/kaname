//go:build linux

package linux

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"syscall"
	"time"

	"github.com/shirou/gopsutil/v3/process"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Processes.
 *
 * Everything here reads procfs through gopsutil. The only write is
 * process.signal, and it takes an enumerated signal name rather than a
 * number, so there is no path from the panel to `kill -9 1` by typo.
 * ------------------------------------------------------------------ */

// The signal set the contract exposes. A name outside this map never
// reaches a syscall.
var signals = map[string]syscall.Signal{
	"SIGTERM": syscall.SIGTERM,
	"SIGKILL": syscall.SIGKILL,
	"SIGHUP":  syscall.SIGHUP,
	"SIGINT":  syscall.SIGINT,
	"SIGUSR1": syscall.SIGUSR1,
	"SIGUSR2": syscall.SIGUSR2,
	"SIGSTOP": syscall.SIGSTOP,
	"SIGCONT": syscall.SIGCONT,
}

// cmdlineLimit keeps one pathological java invocation from dominating a
// process list frame.
const cmdlineLimit = 2048

type processOps struct{ p *provider }

func (o processOps) List(ctx context.Context, p providers.ProcessListParams) (providers.ProcessListResult, error) {
	all, err := o.snapshot(ctx)
	if err != nil {
		return providers.ProcessListResult{}, err
	}

	if p.User != "" {
		filtered := all[:0]
		for _, entry := range all {
			if entry.User == p.User {
				filtered = append(filtered, entry)
			}
		}
		all = filtered
	}
	total := len(all)

	switch p.Sort {
	case "memory":
		sortSlice(all, func(a, b providers.ProcessInfo) bool { return a.MemoryRSS > b.MemoryRSS })
	case "pid":
		sortSlice(all, func(a, b providers.ProcessInfo) bool { return a.PID < b.PID })
	case "name":
		sortSlice(all, func(a, b providers.ProcessInfo) bool { return a.Command < b.Command })
	default:
		sortSlice(all, func(a, b providers.ProcessInfo) bool { return a.CPUPercent > b.CPUPercent })
	}

	if p.Limit > 0 && len(all) > p.Limit {
		all = all[:p.Limit]
	}
	return providers.ProcessListResult{Processes: all, Total: total}, nil
}

func (o processOps) Tree(ctx context.Context, p providers.ProcessTreeParams) ([]providers.ProcessNode, error) {
	all, err := o.snapshot(ctx)
	if err != nil {
		return nil, err
	}

	byPID := make(map[int]providers.ProcessInfo, len(all))
	children := map[int][]int{}
	for _, entry := range all {
		byPID[entry.PID] = entry
		children[entry.PPID] = append(children[entry.PPID], entry.PID)
	}
	for parent := range children {
		sortSlice(children[parent], func(a, b int) bool { return a < b })
	}

	roots := []int{}
	if p.PID != nil {
		if _, ok := byPID[*p.PID]; !ok {
			return nil, notFound("process %d", *p.PID)
		}
		roots = append(roots, *p.PID)
	} else {
		for _, entry := range all {
			if _, hasParent := byPID[entry.PPID]; !hasParent || entry.PPID == entry.PID {
				roots = append(roots, entry.PID)
			}
		}
		sortSlice(roots, func(a, b int) bool { return a < b })
	}

	nodes := make([]providers.ProcessNode, 0, len(all))
	// Iterative rather than recursive: a corrupted ppid chain on a busy
	// host must not be able to blow the stack of the agent.
	type frame struct {
		pid   int
		depth int
	}
	visited := map[int]struct{}{}
	for i := len(roots) - 1; i >= 0; i-- {
		stack := []frame{{pid: roots[i], depth: 0}}
		for len(stack) > 0 {
			current := stack[len(stack)-1]
			stack = stack[:len(stack)-1]

			if _, seen := visited[current.pid]; seen {
				continue
			}
			visited[current.pid] = struct{}{}

			info, ok := byPID[current.pid]
			if !ok {
				continue
			}
			nodes = append(nodes, providers.ProcessNode{ProcessInfo: info, Depth: current.depth})

			kids := children[current.pid]
			for j := len(kids) - 1; j >= 0; j-- {
				if kids[j] != current.pid {
					stack = append(stack, frame{pid: kids[j], depth: current.depth + 1})
				}
			}
		}
	}
	return nodes, nil
}

func (o processOps) Signal(ctx context.Context, p providers.SignalParams) error {
	signal, ok := signals[p.Signal]
	if !ok {
		return invalid("%s is not a permitted signal", p.Signal)
	}
	// Signalling pid 1 would take the host down with a "restart this
	// service" click; the panel has system.reboot for that.
	if p.PID == 1 {
		return invalid("pid 1 may not be signalled; use system.reboot")
	}

	exists, err := process.PidExistsWithContext(ctx, int32(p.PID))
	if err != nil {
		return fmt.Errorf("check pid %d: %w", p.PID, err)
	}
	if !exists {
		return notFound("process %d", p.PID)
	}

	if err := syscall.Kill(p.PID, signal); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return notFound("process %d", p.PID)
		}
		if errors.Is(err, syscall.EPERM) {
			return fmt.Errorf("signal %d: %w", p.PID, providers.ErrPermissionDenied)
		}
		return fmt.Errorf("signal %d with %s: %w", p.PID, p.Signal, err)
	}
	return nil
}

/* ------------------------------- internals --------------------------- */

// snapshot reads the whole process table once. A process that exits
// mid-walk is skipped rather than failing the call: the table is a
// sample, not a transaction.
func (o processOps) snapshot(ctx context.Context) ([]providers.ProcessInfo, error) {
	handles, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return nil, fmt.Errorf("read process table: %w", err)
	}

	out := make([]providers.ProcessInfo, 0, len(handles))
	for _, handle := range handles {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		info, ok := o.describe(ctx, handle)
		if !ok {
			continue
		}
		out = append(out, info)
	}
	return out, nil
}

func (o processOps) describe(ctx context.Context, handle *process.Process) (providers.ProcessInfo, bool) {
	name, err := handle.NameWithContext(ctx)
	if err != nil {
		return providers.ProcessInfo{}, false
	}

	info := providers.ProcessInfo{
		PID:     int(handle.Pid),
		Command: name,
		State:   "unknown",
	}
	if ppid, err := handle.PpidWithContext(ctx); err == nil {
		info.PPID = int(ppid)
	}
	if username, err := handle.UsernameWithContext(ctx); err == nil {
		info.User = username
	} else if uids, err := handle.UidsWithContext(ctx); err == nil && len(uids) > 0 {
		info.User = o.p.names.user(int(uids[0]))
	}
	if cmdline, err := handle.CmdlineWithContext(ctx); err == nil {
		info.Cmdline = truncateString(strings.TrimSpace(cmdline), cmdlineLimit)
	}
	if info.Cmdline == "" {
		// Kernel threads have an empty cmdline; showing the bracketed name
		// is what ps does and what an operator expects to see.
		info.Cmdline = "[" + name + "]"
	}
	if states, err := handle.StatusWithContext(ctx); err == nil && len(states) > 0 {
		info.State = processState(states[0])
	}
	if percent, err := handle.CPUPercentWithContext(ctx); err == nil {
		info.CPUPercent = clampPercent(percent)
	}
	if memory, err := handle.MemoryInfoWithContext(ctx); err == nil && memory != nil {
		info.MemoryRSS = int64(memory.RSS)
	}
	if percent, err := handle.MemoryPercentWithContext(ctx); err == nil {
		info.MemoryPercent = clampPercent(float64(percent))
	}
	if threads, err := handle.NumThreadsWithContext(ctx); err == nil {
		info.Threads = int(threads)
	}
	if created, err := handle.CreateTimeWithContext(ctx); err == nil && created > 0 {
		info.StartedAt = rfc3339(time.UnixMilli(created))
	} else {
		info.StartedAt = nowRFC3339()
	}
	if nice, err := handle.NiceWithContext(ctx); err == nil {
		info.Nice = int(nice)
	}
	return info, true
}

// processState narrows gopsutil's vocabulary to the contract's enum.
func processState(state string) string {
	switch state {
	case process.Running:
		return "running"
	case process.Sleep, process.Wait, process.Lock:
		return "sleeping"
	case process.Blocked:
		return "disk_sleep"
	case process.Stop:
		return "stopped"
	case process.Zombie:
		return "zombie"
	case process.Idle:
		return "idle"
	default:
		return "unknown"
	}
}

func truncateString(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	return s[:limit] + "…"
}
