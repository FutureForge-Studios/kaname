//go:build linux

package linux

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/host"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * systemd.
 *
 * Driven through systemctl with argv slices rather than the dbus
 * bindings: the dependency surface stays at zero and the machine-readable
 * output (`show` returns Key=Value, `list-units --plain` returns fixed
 * columns) is stable enough to parse without a library.
 * ------------------------------------------------------------------ */

// The property set behind every ServiceInfo. Requesting them explicitly
// keeps `systemctl show` output small and its column order ours.
var unitProperties = []string{
	"Id", "Description", "LoadState", "ActiveState", "SubState",
	"UnitFileState", "MainPID", "MemoryCurrent", "CPUUsageNSec",
	"ActiveEnterTimestampMonotonic", "NRestarts",
}

// systemd reports "[not set]" for a counter it has no value for, and
// 2^64-1 for an unset 64-bit property.
const unsetProperty = "18446744073709551615"

type serviceOps struct{ p *provider }

func (s serviceOps) List(ctx context.Context, p providers.ServiceListParams) ([]providers.ServiceInfo, error) {
	if err := s.p.require(providers.CapSystemd); err != nil {
		return nil, err
	}

	args := []string{"list-units", "--type=service", "--all", "--full", "--plain", "--no-legend", "--no-pager"}
	if p.State != "" {
		if err := checkUnitState(p.State); err != nil {
			return nil, err
		}
		args = append(args, "--state="+p.State)
	}
	if p.Pattern != "" {
		if err := checkUnitPattern(p.Pattern); err != nil {
			return nil, err
		}
		args = append(args, p.Pattern)
	}

	out, err := runWith(ctx, execOptions{Name: "systemctl", Args: args, Env: cLocale()})
	if err != nil {
		return nil, err
	}

	names := make([]string, 0, 64)
	descriptions := map[string]string{}
	for _, line := range splitLines(out) {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		// A unit systemd cannot find is prefixed with a bullet in some
		// versions; the name is still the first real field.
		name := strings.TrimPrefix(fields[0], "●")
		if name == "" || !strings.HasSuffix(name, ".service") {
			continue
		}
		names = append(names, name)
		if len(fields) > 4 {
			descriptions[name] = strings.Join(fields[4:], " ")
		}
	}
	if len(names) == 0 {
		return []providers.ServiceInfo{}, nil
	}

	enabled, err := s.enabledStates(ctx)
	if err != nil {
		return nil, err
	}
	units, err := s.show(ctx, names)
	if err != nil {
		return nil, err
	}

	services := make([]providers.ServiceInfo, 0, len(names))
	for _, name := range names {
		info, ok := units[name]
		if !ok {
			info = providers.ServiceInfo{Unit: name, ActiveState: "unknown", LoadState: "not-found"}
		}
		if info.Description == "" {
			info.Description = descriptions[name]
		}
		info.Enabled = enabled[name]
		services = append(services, info)
	}
	sortSlice(services, func(a, b providers.ServiceInfo) bool { return a.Unit < b.Unit })
	return services, nil
}

func (s serviceOps) Status(ctx context.Context, unit string) (providers.ServiceInfo, error) {
	if err := s.p.require(providers.CapSystemd); err != nil {
		return providers.ServiceInfo{}, err
	}

	name := qualify(unit)
	units, err := s.show(ctx, []string{name})
	if err != nil {
		return providers.ServiceInfo{}, err
	}
	info, ok := units[name]
	if !ok {
		return providers.ServiceInfo{}, notFound("unit %s", name)
	}
	if info.LoadState == "not-found" {
		return providers.ServiceInfo{}, notFound("unit %s", name)
	}

	enabled, err := s.enabledStates(ctx)
	if err == nil {
		info.Enabled = enabled[name]
	}
	return info, nil
}

func (s serviceOps) Start(ctx context.Context, unit string) (providers.ServiceInfo, error) {
	return s.act(ctx, "start", unit)
}

func (s serviceOps) Stop(ctx context.Context, unit string) (providers.ServiceInfo, error) {
	return s.act(ctx, "stop", unit)
}

func (s serviceOps) Restart(ctx context.Context, unit string) (providers.ServiceInfo, error) {
	return s.act(ctx, "restart", unit)
}

func (s serviceOps) Reload(ctx context.Context, unit string) (providers.ServiceInfo, error) {
	return s.act(ctx, "reload", unit)
}

func (s serviceOps) Enable(ctx context.Context, unit string) (providers.ServiceInfo, error) {
	return s.act(ctx, "enable", unit)
}

func (s serviceOps) Disable(ctx context.Context, unit string) (providers.ServiceInfo, error) {
	return s.act(ctx, "disable", unit)
}

func (s serviceOps) Logs(ctx context.Context, p providers.ServiceLogsParams, stream providers.Stream) ([]providers.LogRecord, error) {
	if err := s.p.require(providers.CapSystemd); err != nil {
		return nil, err
	}

	name := qualify(p.Unit)
	args := []string{"--unit=" + name}
	if p.Since != "" {
		since, err := journalSince(p.Since)
		if err != nil {
			return nil, err
		}
		args = append(args, "--since="+since)
	}
	return journal(ctx, journalQuery{
		Args:   args,
		Source: name,
		Lines:  p.Lines,
		Follow: p.Follow,
	}, stream)
}

/* ------------------------------- internals --------------------------- */

func (s serviceOps) act(ctx context.Context, verb, unit string) (providers.ServiceInfo, error) {
	if err := s.p.require(providers.CapSystemd); err != nil {
		return providers.ServiceInfo{}, err
	}

	name := qualify(unit)
	if _, err := runWith(ctx, execOptions{Name: "systemctl", Args: []string{verb, name}, Env: cLocale()}); err != nil {
		return providers.ServiceInfo{}, err
	}
	// The unit's own state is what the panel renders, so report it as it
	// is now rather than assuming the verb's intent took effect.
	return s.Status(ctx, name)
}

// show reads the property block for a batch of units in one exec. Blocks
// are separated by a blank line and keyed by Id.
func (s serviceOps) show(ctx context.Context, names []string) (map[string]providers.ServiceInfo, error) {
	args := []string{"show", "--no-pager"}
	for _, property := range unitProperties {
		args = append(args, "--property="+property)
	}
	args = append(args, names...)

	out, err := runWith(ctx, execOptions{Name: "systemctl", Args: args, Env: cLocale()})
	if err != nil {
		return nil, err
	}

	boot := bootTime(ctx)
	units := map[string]providers.ServiceInfo{}
	block := map[string]string{}

	flush := func() {
		if len(block) == 0 {
			return
		}
		if info, ok := unitFromProperties(block, boot); ok {
			units[info.Unit] = info
		}
		block = map[string]string{}
	}

	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			flush()
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		block[key] = value
	}
	flush()

	return units, nil
}

func unitFromProperties(block map[string]string, boot time.Time) (providers.ServiceInfo, bool) {
	name := block["Id"]
	if name == "" {
		return providers.ServiceInfo{}, false
	}

	info := providers.ServiceInfo{
		Unit:        name,
		Description: block["Description"],
		LoadState:   block["LoadState"],
		ActiveState: activeState(block["ActiveState"]),
		SubState:    block["SubState"],
	}
	if pid, err := strconv.Atoi(block["MainPID"]); err == nil && pid > 0 {
		info.MainPID = &pid
	}
	if memory := parseUnsigned(block["MemoryCurrent"]); memory != nil {
		info.MemoryCurrent = memory
	}
	if cpuNs := parseUnsigned(block["CPUUsageNSec"]); cpuNs != nil {
		usage := float64(*cpuNs)
		info.CPUUsageNs = &usage
	}
	if restarts, err := strconv.Atoi(block["NRestarts"]); err == nil && restarts >= 0 {
		info.RestartCount = restarts
	}
	// The monotonic timestamp is locale-independent, unlike the human
	// form systemctl prints beside it.
	if since := parseUnsigned(block["ActiveEnterTimestampMonotonic"]); since != nil && *since > 0 && !boot.IsZero() {
		info.ActiveSince = stringPtr(rfc3339(boot.Add(time.Duration(*since) * time.Microsecond)))
	}
	return info, true
}

// enabledStates reads the unit-file table once, because asking
// `is-enabled` per unit would be one exec per row.
func (s serviceOps) enabledStates(ctx context.Context) (map[string]bool, error) {
	out, err := runWith(ctx, execOptions{
		Name: "systemctl",
		Args: []string{"list-unit-files", "--type=service", "--full", "--plain", "--no-legend", "--no-pager"},
		Env:  cLocale(),
	})
	if err != nil {
		return nil, err
	}

	states := map[string]bool{}
	for _, line := range splitLines(out) {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[1] {
		case "enabled", "enabled-runtime", "static", "indirect", "alias":
			states[fields[0]] = fields[1] == "enabled" || fields[1] == "enabled-runtime"
		default:
			states[fields[0]] = false
		}
	}
	return states, nil
}

func bootTime(ctx context.Context) time.Time {
	seconds, err := host.BootTimeWithContext(ctx)
	if err != nil || seconds == 0 {
		return time.Time{}
	}
	return time.Unix(int64(seconds), 0)
}

// activeState narrows systemd's vocabulary to the contract's enum, so an
// unfamiliar value renders as `unknown` instead of breaking validation.
func activeState(value string) string {
	switch value {
	case "active", "reloading", "inactive", "failed", "activating", "deactivating":
		return value
	default:
		return "unknown"
	}
}

// qualify defaults a bare name to a .service unit, which is what an
// operator means when they type "nginx".
func qualify(unit string) string {
	if strings.ContainsRune(unit, '.') {
		return unit
	}
	return unit + ".service"
}

func parseUnsigned(value string) *int64 {
	if value == "" || value == unsetProperty || value == "[not set]" {
		return nil
	}
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil {
		return nil
	}
	return int64Ptr(int64(parsed))
}

func checkUnitState(state string) error {
	switch state {
	case "active", "reloading", "inactive", "failed", "activating", "deactivating",
		"running", "exited", "dead", "enabled", "disabled", "static":
		return nil
	default:
		return invalid("state %q is not a systemd unit state", state)
	}
}

// checkUnitPattern allows a systemd glob and nothing that would confuse
// systemctl into reading it as an option.
func checkUnitPattern(pattern string) error {
	if strings.HasPrefix(pattern, "-") {
		return invalid("pattern may not start with a dash")
	}
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '.', c == '-', c == '_', c == '@', c == '*', c == '?', c == '\\':
		default:
			return invalid("pattern contains an illegal character")
		}
	}
	return nil
}
