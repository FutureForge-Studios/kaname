package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"path"
	"path/filepath"
	"strings"
	"sync"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Method wiring.
 *
 * One entry per verb in the contract's registry, each decoding a typed
 * parameter struct and calling exactly one provider method. Nothing here
 * builds a command line, and every path argument is re-validated against
 * the host before it is used: the control plane already checked it, but
 * a compromised control plane must not be able to walk the agent out of
 * bounds or at the agent's own private key.
 * ------------------------------------------------------------------ */

// Capability requirements, mirroring the contract's `requires` lists.
var (
	needsSystemd = []string{providers.CapSystemd}
	needsDocker  = []string{providers.CapDocker}
	needsNginx   = []string{providers.CapNginx}
	needsMail    = []string{providers.CapMail}
)

type handlers struct {
	provider providers.Provider
	paths    pathGuard

	mu         sync.Mutex
	ptySession string
}

// RegisterHandlers wires the whole method registry to a provider.
// guardedDirs are directories no file verb may reach — the agent's own
// state directory, which holds the enrolled private key.
func RegisterHandlers(r *Registry, provider providers.Provider, guardedDirs ...string) {
	h := &handlers{provider: provider, paths: newPathGuard(guardedDirs...)}

	h.registerSystem(r)
	h.registerServices(r)
	h.registerProcesses(r)
	h.registerContainers(r)
	h.registerFiles(r)
	h.registerSites(r)
	h.registerCerts(r)
	h.registerDNS(r)
	h.registerMail(r)
	h.registerDatabases(r)
	h.registerFirewall(r)
	h.registerSSH(r)
	h.registerBackups(r)
	h.registerLogs(r)
	h.registerPTY(r)
}

/* ------------------------------- system ------------------------------ */

func (h *handlers) registerSystem(r *Registry) {
	r.Register(Method{Name: "system.info", Mode: StreamNone, Handler: func(ctx context.Context, _ *Request) (any, error) {
		return h.provider.System().Info(ctx)
	}})

	r.Register(Method{Name: "system.metrics", Mode: StreamNone, Handler: func(ctx context.Context, _ *Request) (any, error) {
		return h.provider.System().Metrics(ctx)
	}})

	r.Register(Method{Name: "system.reboot", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.SystemRebootParams](req)
		if err != nil {
			return nil, err
		}
		if p.DelaySeconds < 0 || p.DelaySeconds > 3600 {
			return nil, Errorf(CodeInvalidParams, "delay_seconds must be between 0 and 3600")
		}
		return providers.Ok, h.provider.System().Reboot(ctx, p)
	}})

	r.Register(Method{Name: "system.packages.list", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.PackagesListParams](req)
		if err != nil {
			return nil, err
		}
		packages, err := h.provider.System().ListPackages(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.PackagesListResult{Packages: packages}, nil
	}})

	r.Register(Method{Name: "system.packages.upgrade", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.PackagesUpgradeParams](req)
		if err != nil {
			return nil, err
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.System().UpgradePackages(ctx, p, stream)
	}})

	r.Register(Method{Name: "system.self_update", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.SelfUpdateParams](req)
		if err != nil {
			return nil, err
		}
		if p.Version == "" || p.URL == "" {
			return nil, Errorf(CodeInvalidParams, "version and url are required")
		}
		// Checked here as well as in the downloader: a call that cannot
		// possibly verify what it fetches is refused before anything is
		// fetched at all.
		if len(p.SHA256) != 64 {
			return nil, Errorf(CodeInvalidParams, "sha256 must be 64 hexadecimal characters")
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.System().SelfUpdate(ctx, p, stream)
	}})
}

/* ------------------------------ services ----------------------------- */

func (h *handlers) registerServices(r *Registry) {
	r.Register(Method{Name: "service.list", Mode: StreamNone, Requires: needsSystemd, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.ServiceListParams](req)
		if err != nil {
			return nil, err
		}
		services, err := h.provider.Services().List(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.ServiceListResult{Services: services}, nil
	}})

	unitAction := func(name string, call func(providers.Services) func(context.Context, string) (providers.ServiceInfo, error)) {
		r.Register(Method{Name: name, Mode: StreamNone, Requires: needsSystemd, Handler: func(ctx context.Context, req *Request) (any, error) {
			p, err := decode[providers.UnitParams](req)
			if err != nil {
				return nil, err
			}
			if err := checkUnit(p.Unit); err != nil {
				return nil, err
			}
			return call(h.provider.Services())(ctx, p.Unit)
		}})
	}

	unitAction("service.status", func(s providers.Services) func(context.Context, string) (providers.ServiceInfo, error) {
		return s.Status
	})
	unitAction("service.start", func(s providers.Services) func(context.Context, string) (providers.ServiceInfo, error) {
		return s.Start
	})
	unitAction("service.stop", func(s providers.Services) func(context.Context, string) (providers.ServiceInfo, error) { return s.Stop })
	unitAction("service.restart", func(s providers.Services) func(context.Context, string) (providers.ServiceInfo, error) {
		return s.Restart
	})
	unitAction("service.reload", func(s providers.Services) func(context.Context, string) (providers.ServiceInfo, error) {
		return s.Reload
	})
	unitAction("service.enable", func(s providers.Services) func(context.Context, string) (providers.ServiceInfo, error) {
		return s.Enable
	})
	unitAction("service.disable", func(s providers.Services) func(context.Context, string) (providers.ServiceInfo, error) {
		return s.Disable
	})

	r.Register(Method{Name: "service.logs", Mode: StreamResponse, Requires: needsSystemd, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.ServiceLogsParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkUnit(p.Unit); err != nil {
			return nil, err
		}
		p.Lines = orDefaultInt(p.Lines, 200)
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		records, err := h.provider.Services().Logs(ctx, p, stream)
		if err != nil {
			return nil, err
		}
		return providers.LogRecordsResult{Records: records}, nil
	}})
}

/* ----------------------------- processes ----------------------------- */

func (h *handlers) registerProcesses(r *Registry) {
	r.Register(Method{Name: "process.list", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.ProcessListParams](req)
		if err != nil {
			return nil, err
		}
		p.Sort = orDefaultStr(p.Sort, "cpu")
		if err := checkEnum("sort", p.Sort, "cpu", "memory", "pid", "name"); err != nil {
			return nil, err
		}
		p.Limit = orDefaultInt(p.Limit, 200)
		if p.User != "" {
			if err := checkIdentifier("user", p.User); err != nil {
				return nil, err
			}
		}
		return h.provider.Processes().List(ctx, p)
	}})

	r.Register(Method{Name: "process.tree", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.ProcessTreeParams](req)
		if err != nil {
			return nil, err
		}
		if p.PID != nil && *p.PID <= 0 {
			return nil, Errorf(CodeInvalidParams, "pid must be positive")
		}
		nodes, err := h.provider.Processes().Tree(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.ProcessTreeResult{Processes: nodes}, nil
	}})

	r.Register(Method{Name: "process.signal", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.SignalParams](req)
		if err != nil {
			return nil, err
		}
		if p.PID <= 0 {
			return nil, Errorf(CodeInvalidParams, "pid must be positive")
		}
		if err := checkEnum("signal", p.Signal,
			"SIGTERM", "SIGKILL", "SIGHUP", "SIGINT", "SIGUSR1", "SIGUSR2", "SIGSTOP", "SIGCONT"); err != nil {
			return nil, err
		}
		return providers.Ok, h.provider.Processes().Signal(ctx, p)
	}})
}

/* ----------------------------- containers ---------------------------- */

func (h *handlers) registerContainers(r *Registry) {
	r.Register(Method{Name: "container.list", Mode: StreamNone, Requires: needsDocker, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.ContainerListParams](req)
		if err != nil {
			return nil, err
		}
		containers, err := h.provider.Containers().List(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.ContainerListResult{Containers: containers}, nil
	}})

	r.Register(Method{Name: "container.inspect", Mode: StreamNone, Requires: needsDocker, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decodeContainerID(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Containers().Inspect(ctx, p.ID)
	}})

	r.Register(Method{Name: "container.start", Mode: StreamNone, Requires: needsDocker, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decodeContainerID(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Containers().Start(ctx, p.ID)
	}})

	r.Register(Method{Name: "container.stop", Mode: StreamNone, Requires: needsDocker, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.ContainerStopParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkContainerID(p.ID); err != nil {
			return nil, err
		}
		return h.provider.Containers().Stop(ctx, p)
	}})

	r.Register(Method{Name: "container.restart", Mode: StreamNone, Requires: needsDocker, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.ContainerStopParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkContainerID(p.ID); err != nil {
			return nil, err
		}
		return h.provider.Containers().Restart(ctx, p)
	}})

	r.Register(Method{Name: "container.remove", Mode: StreamNone, Requires: needsDocker, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.ContainerRemoveParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkContainerID(p.ID); err != nil {
			return nil, err
		}
		return providers.Ok, h.provider.Containers().Remove(ctx, p)
	}})

	r.Register(Method{Name: "container.logs", Mode: StreamResponse, Requires: needsDocker, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.ContainerLogsParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkContainerID(p.ID); err != nil {
			return nil, err
		}
		p.Lines = orDefaultInt(p.Lines, 200)
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		records, err := h.provider.Containers().Logs(ctx, p, stream)
		if err != nil {
			return nil, err
		}
		return providers.LogRecordsResult{Records: records}, nil
	}})

	r.Register(Method{Name: "container.exec", Mode: StreamBidirectional, Requires: needsDocker, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.ContainerExecParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkContainerID(p.ID); err != nil {
			return nil, err
		}
		p.Cols = orDefaultInt(p.Cols, 80)
		p.Rows = orDefaultInt(p.Rows, 24)
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return providers.Ok, h.provider.Containers().Exec(ctx, p, stream)
	}})

	r.Register(Method{Name: "container.images.list", Mode: StreamNone, Requires: needsDocker, Handler: func(ctx context.Context, _ *Request) (any, error) {
		images, err := h.provider.Containers().Images(ctx)
		if err != nil {
			return nil, err
		}
		return providers.ImageListResult{Images: images}, nil
	}})

	r.Register(Method{Name: "container.prune", Mode: StreamNone, Requires: needsDocker, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.ContainerPruneParams](req)
		if err != nil {
			return nil, err
		}
		return h.provider.Containers().Prune(ctx, p)
	}})
}

/* ------------------------------- files ------------------------------- */

func (h *handlers) registerFiles(r *Registry) {
	r.Register(Method{Name: "fs.list", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsListParams](req)
		if err != nil {
			return nil, err
		}
		if p.Path, err = h.paths.check(p.Path); err != nil {
			return nil, err
		}
		p.Limit = orDefaultInt(p.Limit, 1000)
		return h.provider.Files().List(ctx, p)
	}})

	r.Register(Method{Name: "fs.stat", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsStatParams](req)
		if err != nil {
			return nil, err
		}
		if p.Path, err = h.paths.check(p.Path); err != nil {
			return nil, err
		}
		return h.provider.Files().Stat(ctx, p.Path)
	}})

	r.Register(Method{Name: "fs.read", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsReadParams](req)
		if err != nil {
			return nil, err
		}
		if p.Path, err = h.paths.check(p.Path); err != nil {
			return nil, err
		}
		if p.MaxBytes <= 0 {
			p.MaxBytes = 1024 * 1024
		}
		return h.provider.Files().Read(ctx, p)
	}})

	r.Register(Method{Name: "fs.write", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsWriteParams](req)
		if err != nil {
			return nil, err
		}
		if p.Path, err = h.paths.check(p.Path); err != nil {
			return nil, err
		}
		p.Encoding = orDefaultStr(p.Encoding, "utf8")
		if err := checkEnum("encoding", p.Encoding, "utf8", "base64"); err != nil {
			return nil, err
		}
		if err := checkMode(p.Mode); err != nil {
			return nil, err
		}
		return h.provider.Files().Write(ctx, p)
	}})

	r.Register(Method{Name: "fs.mkdir", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsMkdirParams](req)
		if err != nil {
			return nil, err
		}
		if p.Path, err = h.paths.check(p.Path); err != nil {
			return nil, err
		}
		if err := checkMode(p.Mode); err != nil {
			return nil, err
		}
		return h.provider.Files().Mkdir(ctx, p)
	}})

	r.Register(Method{Name: "fs.move", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsMoveParams](req)
		if err != nil {
			return nil, err
		}
		if p.From, err = h.paths.check(p.From); err != nil {
			return nil, err
		}
		if p.To, err = h.paths.check(p.To); err != nil {
			return nil, err
		}
		return h.provider.Files().Move(ctx, p)
	}})

	r.Register(Method{Name: "fs.copy", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsCopyParams](req)
		if err != nil {
			return nil, err
		}
		if p.From, err = h.paths.check(p.From); err != nil {
			return nil, err
		}
		if p.To, err = h.paths.check(p.To); err != nil {
			return nil, err
		}
		return h.provider.Files().Copy(ctx, p)
	}})

	r.Register(Method{Name: "fs.remove", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsRemoveParams](req)
		if err != nil {
			return nil, err
		}
		if p.Paths, err = h.paths.checkAll(p.Paths); err != nil {
			return nil, err
		}
		removed, err := h.provider.Files().Remove(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.FsRemoveResult{Removed: removed}, nil
	}})

	r.Register(Method{Name: "fs.chmod", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsChmodParams](req)
		if err != nil {
			return nil, err
		}
		if p.Paths, err = h.paths.checkAll(p.Paths); err != nil {
			return nil, err
		}
		if p.Mode == "" {
			return nil, Errorf(CodeInvalidParams, "mode is required")
		}
		if err := checkMode(p.Mode); err != nil {
			return nil, err
		}
		return providers.Ok, h.provider.Files().Chmod(ctx, p)
	}})

	r.Register(Method{Name: "fs.chown", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsChownParams](req)
		if err != nil {
			return nil, err
		}
		if p.Paths, err = h.paths.checkAll(p.Paths); err != nil {
			return nil, err
		}
		if p.Owner == "" && p.Group == "" {
			return nil, Errorf(CodeInvalidParams, "one of owner or group is required")
		}
		if p.Owner != "" {
			if err := checkIdentifier("owner", p.Owner); err != nil {
				return nil, err
			}
		}
		if p.Group != "" {
			if err := checkIdentifier("group", p.Group); err != nil {
				return nil, err
			}
		}
		return providers.Ok, h.provider.Files().Chown(ctx, p)
	}})

	r.Register(Method{Name: "fs.archive", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsArchiveParams](req)
		if err != nil {
			return nil, err
		}
		if p.Paths, err = h.paths.checkAll(p.Paths); err != nil {
			return nil, err
		}
		if p.Destination, err = h.paths.check(p.Destination); err != nil {
			return nil, err
		}
		p.Format = orDefaultStr(p.Format, "tar.gz")
		if err := checkEnum("format", p.Format, "tar.gz", "tar.zst", "zip"); err != nil {
			return nil, err
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Files().Archive(ctx, p, stream)
	}})

	r.Register(Method{Name: "fs.extract", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsExtractParams](req)
		if err != nil {
			return nil, err
		}
		if p.Path, err = h.paths.check(p.Path); err != nil {
			return nil, err
		}
		if p.Destination, err = h.paths.check(p.Destination); err != nil {
			return nil, err
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		extracted, err := h.provider.Files().Extract(ctx, p, stream)
		if err != nil {
			return nil, err
		}
		return providers.FsExtractResult{Extracted: extracted}, nil
	}})

	r.Register(Method{Name: "fs.download", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsDownloadParams](req)
		if err != nil {
			return nil, err
		}
		if p.Path, err = h.paths.check(p.Path); err != nil {
			return nil, err
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Files().Download(ctx, p, stream)
	}})

	r.Register(Method{Name: "fs.upload", Mode: StreamBidirectional, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsUploadParams](req)
		if err != nil {
			return nil, err
		}
		if p.Path, err = h.paths.check(p.Path); err != nil {
			return nil, err
		}
		if p.Size < 0 {
			return nil, Errorf(CodeInvalidParams, "size may not be negative")
		}
		if err := checkMode(p.Mode); err != nil {
			return nil, err
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Files().Upload(ctx, p, stream)
	}})

	r.Register(Method{Name: "fs.usage", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FsUsageParams](req)
		if err != nil {
			return nil, err
		}
		p.Path = orDefaultStr(p.Path, "/")
		if p.Path, err = h.paths.check(p.Path); err != nil {
			return nil, err
		}
		p.Depth = orDefaultInt(p.Depth, 1)
		if p.Depth > 4 {
			p.Depth = 4
		}
		return h.provider.Files().Usage(ctx, p)
	}})
}

/* ------------------------------- sites ------------------------------- */

func (h *handlers) registerSites(r *Registry) {
	r.Register(Method{Name: "site.list", Mode: StreamNone, Requires: needsNginx, Handler: func(ctx context.Context, _ *Request) (any, error) {
		sites, err := h.provider.Sites().List(ctx)
		if err != nil {
			return nil, err
		}
		return providers.SiteListResult{Sites: sites}, nil
	}})

	r.Register(Method{Name: "site.create", Mode: StreamNone, Requires: needsNginx, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.SiteCreateParams](req)
		if err != nil {
			return nil, err
		}
		if p.Name == "" || len(p.ServerNames) == 0 {
			return nil, Errorf(CodeInvalidParams, "name and at least one server name are required")
		}
		if p.Webroot, err = h.paths.check(p.Webroot); err != nil {
			return nil, err
		}
		if err := checkEnum("runtime", p.Runtime, "static", "php", "node", "python", "proxy", "container"); err != nil {
			return nil, err
		}
		if p.Owner != "" {
			if err := checkIdentifier("owner", p.Owner); err != nil {
				return nil, err
			}
		}
		return h.provider.Sites().Create(ctx, p)
	}})

	r.Register(Method{Name: "site.update", Mode: StreamNone, Requires: needsNginx, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.SiteUpdateParams](req)
		if err != nil {
			return nil, err
		}
		if p.Name == "" {
			return nil, Errorf(CodeInvalidParams, "name is required")
		}
		if p.Webroot != "" {
			if p.Webroot, err = h.paths.check(p.Webroot); err != nil {
				return nil, err
			}
		}
		return h.provider.Sites().Update(ctx, p)
	}})

	r.Register(Method{Name: "site.remove", Mode: StreamNone, Requires: needsNginx, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.SiteRemoveParams](req)
		if err != nil {
			return nil, err
		}
		if p.Name == "" {
			return nil, Errorf(CodeInvalidParams, "name is required")
		}
		return providers.Ok, h.provider.Sites().Remove(ctx, p)
	}})

	r.Register(Method{Name: "site.test_config", Mode: StreamNone, Requires: needsNginx, Handler: func(ctx context.Context, _ *Request) (any, error) {
		return h.provider.Sites().TestConfig(ctx)
	}})

	r.Register(Method{Name: "site.reload", Mode: StreamNone, Requires: needsNginx, Handler: func(ctx context.Context, _ *Request) (any, error) {
		return providers.Ok, h.provider.Sites().Reload(ctx)
	}})
}

/* ---------------------------- certificates --------------------------- */

func (h *handlers) registerCerts(r *Registry) {
	r.Register(Method{Name: "cert.list", Mode: StreamNone, Handler: func(ctx context.Context, _ *Request) (any, error) {
		certs, err := h.provider.Certs().List(ctx)
		if err != nil {
			return nil, err
		}
		return providers.CertListResult{Certificates: certs}, nil
	}})

	r.Register(Method{Name: "cert.issue", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.CertIssueParams](req)
		if err != nil {
			return nil, err
		}
		if len(p.Domains) == 0 {
			return nil, Errorf(CodeInvalidParams, "at least one domain is required")
		}
		if err := checkEnum("challenge", p.Challenge, "http-01", "dns-01"); err != nil {
			return nil, err
		}
		p.KeyType = orDefaultStr(p.KeyType, "ecdsa")
		if err := checkEnum("key_type", p.KeyType, "ecdsa", "rsa"); err != nil {
			return nil, err
		}
		if p.Webroot != "" {
			if p.Webroot, err = h.paths.check(p.Webroot); err != nil {
				return nil, err
			}
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Certs().Issue(ctx, p, stream)
	}})

	r.Register(Method{Name: "cert.renew", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.CertRenewParams](req)
		if err != nil {
			return nil, err
		}
		if p.Subject == "" {
			return nil, Errorf(CodeInvalidParams, "subject is required")
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Certs().Renew(ctx, p, stream)
	}})

	r.Register(Method{Name: "cert.revoke", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.CertRevokeParams](req)
		if err != nil {
			return nil, err
		}
		if p.Subject == "" {
			return nil, Errorf(CodeInvalidParams, "subject is required")
		}
		p.Reason = orDefaultStr(p.Reason, "unspecified")
		return providers.Ok, h.provider.Certs().Revoke(ctx, p)
	}})

	r.Register(Method{Name: "cert.install", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.CertInstallParams](req)
		if err != nil {
			return nil, err
		}
		if p.Subject == "" || p.CertificatePEM == "" || p.KeyPEM == "" {
			return nil, Errorf(CodeInvalidParams, "subject, certificate_pem and key_pem are required")
		}
		return h.provider.Certs().Install(ctx, p)
	}})
}

/* -------------------------------- dns -------------------------------- */

func (h *handlers) registerDNS(r *Registry) {
	r.Register(Method{Name: "dns.resolve", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.DNSResolveParams](req)
		if err != nil {
			return nil, err
		}
		if p.Name == "" || p.Type == "" {
			return nil, Errorf(CodeInvalidParams, "name and type are required")
		}
		records, err := h.provider.DNS().Resolve(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.DNSResolveResult{Records: records}, nil
	}})
}

/* -------------------------------- mail ------------------------------- */

func (h *handlers) registerMail(r *Registry) {
	r.Register(Method{Name: "mail.mailbox.list", Mode: StreamNone, Requires: needsMail, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.MailboxListParams](req)
		if err != nil {
			return nil, err
		}
		mailboxes, err := h.provider.Mail().ListMailboxes(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.MailboxListResult{Mailboxes: mailboxes}, nil
	}})

	r.Register(Method{Name: "mail.mailbox.create", Mode: StreamNone, Requires: needsMail, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.MailboxCreateParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkAddress(p.Address); err != nil {
			return nil, err
		}
		if len(p.Password) < 12 {
			return nil, Errorf(CodeInvalidParams, "password must be at least 12 characters")
		}
		return providers.Ok, h.provider.Mail().CreateMailbox(ctx, p)
	}})

	r.Register(Method{Name: "mail.mailbox.update", Mode: StreamNone, Requires: needsMail, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.MailboxUpdateParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkAddress(p.Address); err != nil {
			return nil, err
		}
		return providers.Ok, h.provider.Mail().UpdateMailbox(ctx, p)
	}})

	r.Register(Method{Name: "mail.mailbox.delete", Mode: StreamNone, Requires: needsMail, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.MailboxDeleteParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkAddress(p.Address); err != nil {
			return nil, err
		}
		return providers.Ok, h.provider.Mail().DeleteMailbox(ctx, p)
	}})

	r.Register(Method{Name: "mail.mailbox.password", Mode: StreamNone, Requires: needsMail, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.MailboxPasswordParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkAddress(p.Address); err != nil {
			return nil, err
		}
		if len(p.Password) < 12 {
			return nil, Errorf(CodeInvalidParams, "password must be at least 12 characters")
		}
		return providers.Ok, h.provider.Mail().SetMailboxPassword(ctx, p)
	}})

	r.Register(Method{Name: "mail.alias.apply", Mode: StreamNone, Requires: needsMail, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.MailAliasApplyParams](req)
		if err != nil {
			return nil, err
		}
		if p.Domain == "" {
			return nil, Errorf(CodeInvalidParams, "domain is required")
		}
		for _, alias := range p.Aliases {
			if alias.Address == "" || len(alias.Destinations) == 0 {
				return nil, Errorf(CodeInvalidParams, "every alias needs an address and at least one destination")
			}
		}
		return providers.Ok, h.provider.Mail().ApplyAliases(ctx, p)
	}})

	r.Register(Method{Name: "mail.forwarder.apply", Mode: StreamNone, Requires: needsMail, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.MailForwarderApplyParams](req)
		if err != nil {
			return nil, err
		}
		if p.Domain == "" {
			return nil, Errorf(CodeInvalidParams, "domain is required")
		}
		for _, forwarder := range p.Forwarders {
			if forwarder.Source == "" || forwarder.Destination == "" {
				return nil, Errorf(CodeInvalidParams, "every forwarder needs a source and a destination")
			}
		}
		return providers.Ok, h.provider.Mail().ApplyForwarders(ctx, p)
	}})

	r.Register(Method{Name: "mail.dkim.read", Mode: StreamNone, Requires: needsMail, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.MailDkimReadParams](req)
		if err != nil {
			return nil, err
		}
		if p.Domain == "" {
			return nil, Errorf(CodeInvalidParams, "domain is required")
		}
		return h.provider.Mail().ReadDKIM(ctx, p)
	}})

	r.Register(Method{Name: "mail.queue.list", Mode: StreamNone, Requires: needsMail, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.MailQueueListParams](req)
		if err != nil {
			return nil, err
		}
		p.Limit = orDefaultInt(p.Limit, 200)
		entries, err := h.provider.Mail().Queue(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.MailQueueListResult{Entries: entries}, nil
	}})

	r.Register(Method{Name: "mail.logs", Mode: StreamResponse, Requires: needsMail, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.MailLogsParams](req)
		if err != nil {
			return nil, err
		}
		p.Lines = orDefaultInt(p.Lines, 200)
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		records, err := h.provider.Mail().Logs(ctx, p, stream)
		if err != nil {
			return nil, err
		}
		return providers.LogRecordsResult{Records: records}, nil
	}})
}

/* ------------------------------ databases ---------------------------- */

func (h *handlers) registerDatabases(r *Registry) {
	r.Register(Method{Name: "db.instance.list", Mode: StreamNone, Handler: func(ctx context.Context, _ *Request) (any, error) {
		instances, err := h.provider.Databases().Instances(ctx)
		if err != nil {
			return nil, err
		}
		return providers.DbInstanceListResult{Instances: instances}, nil
	}})

	r.Register(Method{Name: "db.database.list", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decodeEngine(req)
		if err != nil {
			return nil, err
		}
		databases, err := h.provider.Databases().ListDatabases(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.DbDatabaseListResult{Databases: databases}, nil
	}})

	r.Register(Method{Name: "db.database.create", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.DbDatabaseCreateParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkEngine(p.Engine); err != nil {
			return nil, err
		}
		if err := checkIdentifier("name", p.Name); err != nil {
			return nil, err
		}
		if p.Owner != "" {
			if err := checkIdentifier("owner", p.Owner); err != nil {
				return nil, err
			}
		}
		return h.provider.Databases().CreateDatabase(ctx, p)
	}})

	r.Register(Method{Name: "db.database.delete", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.DbDatabaseDeleteParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkEngine(p.Engine); err != nil {
			return nil, err
		}
		if err := checkIdentifier("name", p.Name); err != nil {
			return nil, err
		}
		return providers.Ok, h.provider.Databases().DeleteDatabase(ctx, p)
	}})

	r.Register(Method{Name: "db.user.list", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decodeEngine(req)
		if err != nil {
			return nil, err
		}
		users, err := h.provider.Databases().ListUsers(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.DbUserListResult{Users: users}, nil
	}})

	r.Register(Method{Name: "db.user.create", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.DbUserCreateParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkEngine(p.Engine); err != nil {
			return nil, err
		}
		if err := checkIdentifier("username", p.Username); err != nil {
			return nil, err
		}
		if len(p.Password) < 12 {
			return nil, Errorf(CodeInvalidParams, "password must be at least 12 characters")
		}
		p.HostPattern = orDefaultStr(p.HostPattern, "localhost")
		return h.provider.Databases().CreateUser(ctx, p)
	}})

	r.Register(Method{Name: "db.user.update", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.DbUserUpdateParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkEngine(p.Engine); err != nil {
			return nil, err
		}
		if err := checkIdentifier("username", p.Username); err != nil {
			return nil, err
		}
		if p.Password != "" && len(p.Password) < 12 {
			return nil, Errorf(CodeInvalidParams, "password must be at least 12 characters")
		}
		p.HostPattern = orDefaultStr(p.HostPattern, "localhost")
		return h.provider.Databases().UpdateUser(ctx, p)
	}})

	r.Register(Method{Name: "db.user.delete", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.DbUserDeleteParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkEngine(p.Engine); err != nil {
			return nil, err
		}
		if err := checkIdentifier("username", p.Username); err != nil {
			return nil, err
		}
		p.HostPattern = orDefaultStr(p.HostPattern, "localhost")
		return providers.Ok, h.provider.Databases().DeleteUser(ctx, p)
	}})

	r.Register(Method{Name: "db.grant.apply", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.DbGrantApplyParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkEngine(p.Engine); err != nil {
			return nil, err
		}
		if err := checkIdentifier("database", p.Database); err != nil {
			return nil, err
		}
		if err := checkIdentifier("username", p.Username); err != nil {
			return nil, err
		}
		p.HostPattern = orDefaultStr(p.HostPattern, "localhost")
		for _, privilege := range p.Privileges {
			if err := checkEnum("privileges", strings.ToUpper(privilege),
				"SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER",
				"INDEX", "REFERENCES", "TRIGGER", "EXECUTE", "TEMPORARY", "ALL"); err != nil {
				return nil, err
			}
		}
		return providers.Ok, h.provider.Databases().ApplyGrant(ctx, p)
	}})

	r.Register(Method{Name: "db.size", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.DbSizeParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkEngine(p.Engine); err != nil {
			return nil, err
		}
		if err := checkIdentifier("name", p.Name); err != nil {
			return nil, err
		}
		return h.provider.Databases().Size(ctx, p)
	}})

	r.Register(Method{Name: "db.dump", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.DbDumpParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkEngine(p.Engine); err != nil {
			return nil, err
		}
		if err := checkIdentifier("name", p.Name); err != nil {
			return nil, err
		}
		if p.Destination, err = h.paths.check(p.Destination); err != nil {
			return nil, err
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Databases().Dump(ctx, p, stream)
	}})

	r.Register(Method{Name: "db.restore", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.DbRestoreParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkEngine(p.Engine); err != nil {
			return nil, err
		}
		if err := checkIdentifier("name", p.Name); err != nil {
			return nil, err
		}
		if p.Source, err = h.paths.check(p.Source); err != nil {
			return nil, err
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return providers.Ok, h.provider.Databases().Restore(ctx, p, stream)
	}})
}

/* ------------------------------ firewall ----------------------------- */

func (h *handlers) registerFirewall(r *Registry) {
	r.Register(Method{Name: "fw.status", Mode: StreamNone, Handler: func(ctx context.Context, _ *Request) (any, error) {
		return h.provider.Firewall().Status(ctx)
	}})

	r.Register(Method{Name: "fw.list", Mode: StreamNone, Handler: func(ctx context.Context, _ *Request) (any, error) {
		rules, err := h.provider.Firewall().List(ctx)
		if err != nil {
			return nil, err
		}
		return providers.FwListResult{Rules: rules}, nil
	}})

	r.Register(Method{Name: "fw.apply", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FwApplyParams](req)
		if err != nil {
			return nil, err
		}
		p.DefaultInbound = orDefaultStr(p.DefaultInbound, "deny")
		p.DefaultOutbound = orDefaultStr(p.DefaultOutbound, "allow")
		if err := checkEnum("default_inbound", p.DefaultInbound, "allow", "deny"); err != nil {
			return nil, err
		}
		if err := checkEnum("default_outbound", p.DefaultOutbound, "allow", "deny"); err != nil {
			return nil, err
		}
		for _, rule := range p.Rules {
			if err := checkEnum("action", rule.Action, "allow", "deny", "reject"); err != nil {
				return nil, err
			}
			if err := checkEnum("direction", rule.Direction, "inbound", "outbound"); err != nil {
				return nil, err
			}
			if err := checkEnum("protocol", rule.Protocol, "tcp", "udp", "icmp", "any"); err != nil {
				return nil, err
			}
		}
		if p.RollbackSeconds < 0 || p.RollbackSeconds > 300 {
			return nil, Errorf(CodeInvalidParams, "rollback_seconds must be between 0 and 300")
		}
		return h.provider.Firewall().Apply(ctx, p)
	}})

	r.Register(Method{Name: "fw.confirm", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FwConfirmParams](req)
		if err != nil {
			return nil, err
		}
		if p.RollbackToken == "" {
			return nil, Errorf(CodeInvalidParams, "rollback_token is required")
		}
		return providers.Ok, h.provider.Firewall().Confirm(ctx, p)
	}})

	r.Register(Method{Name: "fw.ban", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FwBanParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkTarget(p.Target); err != nil {
			return nil, err
		}
		if p.DurationSeconds < 0 {
			return nil, Errorf(CodeInvalidParams, "duration_seconds may not be negative")
		}
		return providers.Ok, h.provider.Firewall().Ban(ctx, p)
	}})

	r.Register(Method{Name: "fw.unban", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FwUnbanParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkTarget(p.Target); err != nil {
			return nil, err
		}
		return providers.Ok, h.provider.Firewall().Unban(ctx, p)
	}})

	r.Register(Method{Name: "fw.bans.list", Mode: StreamNone, Handler: func(ctx context.Context, _ *Request) (any, error) {
		bans, err := h.provider.Firewall().Bans(ctx)
		if err != nil {
			return nil, err
		}
		return providers.FwBansResult{Bans: bans}, nil
	}})

	r.Register(Method{Name: "fw.threats", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.FwThreatsParams](req)
		if err != nil {
			return nil, err
		}
		p.Limit = orDefaultInt(p.Limit, 500)
		observations, err := h.provider.Firewall().Threats(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.FwThreatsResult{Observations: observations}, nil
	}})
}

/* -------------------------------- ssh -------------------------------- */

func (h *handlers) registerSSH(r *Registry) {
	r.Register(Method{Name: "ssh.keys.list", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.SSHKeysListParams](req)
		if err != nil {
			return nil, err
		}
		if p.User != "" {
			if err := checkIdentifier("user", p.User); err != nil {
				return nil, err
			}
		}
		keys, err := h.provider.SSH().ListKeys(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.SSHKeysListResult{Keys: keys}, nil
	}})

	r.Register(Method{Name: "ssh.keys.apply", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.SSHKeysApplyParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkIdentifier("user", p.User); err != nil {
			return nil, err
		}
		for _, key := range p.Keys {
			// A newline would smuggle a second key line into authorized_keys.
			if key.PublicKey == "" || strings.ContainsAny(key.PublicKey, "\n\r") {
				return nil, Errorf(CodeInvalidParams, "public_key must be a single non-empty line")
			}
			if strings.ContainsAny(key.Comment, "\n\r") {
				return nil, Errorf(CodeInvalidParams, "comment may not contain a newline")
			}
		}
		applied, err := h.provider.SSH().ApplyKeys(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.SSHKeysApplyResult{Applied: applied}, nil
	}})

	r.Register(Method{Name: "ssh.config.read", Mode: StreamNone, Handler: func(ctx context.Context, _ *Request) (any, error) {
		return h.provider.SSH().ReadConfig(ctx)
	}})

	r.Register(Method{Name: "ssh.config.apply", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.SSHConfigApplyParams](req)
		if err != nil {
			return nil, err
		}
		if p.Port != nil && (*p.Port < 1 || *p.Port > 65535) {
			return nil, Errorf(CodeInvalidParams, "port must be between 1 and 65535")
		}
		if p.PermitRootLogin != nil {
			if err := checkEnum("permit_root_login", *p.PermitRootLogin,
				"yes", "no", "prohibit-password", "forced-commands-only"); err != nil {
				return nil, err
			}
		}
		for _, user := range p.AllowUsers {
			if err := checkIdentifier("allow_users", user); err != nil {
				return nil, err
			}
		}
		for _, group := range p.AllowGroups {
			if err := checkIdentifier("allow_groups", group); err != nil {
				return nil, err
			}
		}
		if p.RollbackSeconds < 0 || p.RollbackSeconds > 300 {
			return nil, Errorf(CodeInvalidParams, "rollback_seconds must be between 0 and 300")
		}
		return h.provider.SSH().ApplyConfig(ctx, p)
	}})

	r.Register(Method{Name: "ssh.sessions.list", Mode: StreamNone, Handler: func(ctx context.Context, _ *Request) (any, error) {
		sessions, err := h.provider.SSH().Sessions(ctx)
		if err != nil {
			return nil, err
		}
		return providers.SSHSessionsResult{Sessions: sessions}, nil
	}})
}

/* ------------------------------ backups ------------------------------ */

func (h *handlers) registerBackups(r *Registry) {
	r.Register(Method{Name: "backup.run", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.BackupRunParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkRepository(p.Repository, p.PasswordRef); err != nil {
			return nil, err
		}
		if p.Paths, err = h.paths.checkAll(p.Paths); err != nil {
			return nil, err
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Backups().Run(ctx, p, stream)
	}})

	r.Register(Method{Name: "backup.list", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.BackupListParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkRepository(p.Repository, p.PasswordRef); err != nil {
			return nil, err
		}
		snapshots, err := h.provider.Backups().List(ctx, p)
		if err != nil {
			return nil, err
		}
		return providers.BackupListResult{Snapshots: snapshots}, nil
	}})

	r.Register(Method{Name: "backup.restore", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.BackupRestoreParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkRepository(p.Repository, p.PasswordRef); err != nil {
			return nil, err
		}
		if p.SnapshotID == "" {
			return nil, Errorf(CodeInvalidParams, "snapshot_id is required")
		}
		if p.Target, err = h.paths.check(p.Target); err != nil {
			return nil, err
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Backups().Restore(ctx, p, stream)
	}})

	r.Register(Method{Name: "backup.verify", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.BackupVerifyParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkRepository(p.Repository, p.PasswordRef); err != nil {
			return nil, err
		}
		if p.SnapshotID == "" {
			return nil, Errorf(CodeInvalidParams, "snapshot_id is required")
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Backups().Verify(ctx, p, stream)
	}})

	r.Register(Method{Name: "backup.prune", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.BackupPruneParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkRepository(p.Repository, p.PasswordRef); err != nil {
			return nil, err
		}
		if p.KeepLast < 0 || p.KeepDaily < 0 || p.KeepWeekly < 0 || p.KeepMonthly < 0 {
			return nil, Errorf(CodeInvalidParams, "retention counts may not be negative")
		}
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		return h.provider.Backups().Prune(ctx, p, stream)
	}})
}

/* -------------------------------- logs ------------------------------- */

func (h *handlers) registerLogs(r *Registry) {
	r.Register(Method{Name: "log.sources", Mode: StreamNone, Handler: func(ctx context.Context, _ *Request) (any, error) {
		sources, err := h.provider.Logs().Sources(ctx)
		if err != nil {
			return nil, err
		}
		return providers.LogSourcesResult{Sources: sources}, nil
	}})

	r.Register(Method{Name: "log.tail", Mode: StreamResponse, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.LogTailParams](req)
		if err != nil {
			return nil, err
		}
		if p.Source == "" {
			return nil, Errorf(CodeInvalidParams, "source is required")
		}
		p.Lines = orDefaultInt(p.Lines, 200)
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}
		records, err := h.provider.Logs().Tail(ctx, p, stream)
		if err != nil {
			return nil, err
		}
		return providers.LogRecordsResult{Records: records}, nil
	}})
}

/* -------------------------------- pty -------------------------------- */

func (h *handlers) registerPTY(r *Registry) {
	r.Register(Method{Name: "pty.open", Mode: StreamBidirectional, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.PtyOpenParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkDimensions(p.Cols, p.Rows); err != nil {
			return nil, err
		}
		if p.Cwd != "" {
			if p.Cwd, err = h.paths.check(p.Cwd); err != nil {
				return nil, err
			}
		}
		if p.User != "" {
			if err := checkIdentifier("user", p.User); err != nil {
				return nil, err
			}
		}
		p.Term = orDefaultStr(p.Term, "xterm-256color")
		stream, err := requireStream(req)
		if err != nil {
			return nil, err
		}

		h.setPtySession(req.ID)
		defer h.clearPtySession(req.ID)

		return h.provider.PTY().Open(ctx, req.ID, p, stream)
	}})

	r.Register(Method{Name: "pty.resize", Mode: StreamNone, Handler: func(ctx context.Context, req *Request) (any, error) {
		p, err := decode[providers.PtyResizeParams](req)
		if err != nil {
			return nil, err
		}
		if err := checkDimensions(p.Cols, p.Rows); err != nil {
			return nil, err
		}
		session, err := h.currentPtySession()
		if err != nil {
			return nil, err
		}
		return providers.Ok, h.provider.PTY().Resize(ctx, session, p)
	}})

	r.Register(Method{Name: "pty.close", Mode: StreamNone, Handler: func(ctx context.Context, _ *Request) (any, error) {
		session, err := h.currentPtySession()
		if err != nil {
			return nil, err
		}
		return providers.Ok, h.provider.PTY().Close(ctx, session)
	}})
}

// The contract's pty.resize and pty.close carry no session id, so they
// address the session opened most recently on this connection.
func (h *handlers) setPtySession(id string) {
	h.mu.Lock()
	h.ptySession = id
	h.mu.Unlock()
}

func (h *handlers) clearPtySession(id string) {
	h.mu.Lock()
	if h.ptySession == id {
		h.ptySession = ""
	}
	h.mu.Unlock()
}

func (h *handlers) currentPtySession() (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ptySession == "" {
		return "", Errorf(CodeNotFound, "no terminal session is open")
	}
	return h.ptySession, nil
}

/* ------------------------------ decoding ----------------------------- */

func decode[T any](req *Request) (T, error) {
	var out T
	if len(req.Params) == 0 || string(req.Params) == "null" {
		return out, nil
	}
	if err := json.Unmarshal(req.Params, &out); err != nil {
		return out, Errorf(CodeInvalidParams, "%s: %s", req.Method, err.Error())
	}
	return out, nil
}

func decodeContainerID(req *Request) (providers.ContainerIDParams, error) {
	p, err := decode[providers.ContainerIDParams](req)
	if err != nil {
		return p, err
	}
	return p, checkContainerID(p.ID)
}

func decodeEngine(req *Request) (providers.DbEngineParams, error) {
	p, err := decode[providers.DbEngineParams](req)
	if err != nil {
		return p, err
	}
	return p, checkEngine(p.Engine)
}

func requireStream(req *Request) (*Stream, error) {
	if req.Stream == nil {
		return nil, Errorf(CodeInternal, "%s is a streaming method but no stream was opened", req.Method)
	}
	return req.Stream, nil
}

/* ----------------------------- path guard ---------------------------- */

// pathGuard re-validates every path that crosses the RPC boundary. The
// denied set exists so no file verb can read or overwrite the agent's
// own key material, whether it is named directly or reached by symlink.
type pathGuard struct {
	denied []string
}

func newPathGuard(dirs ...string) pathGuard {
	guard := pathGuard{}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		absolute, err := filepath.Abs(dir)
		if err != nil {
			absolute = dir
		}
		guard.denied = append(guard.denied, path.Clean(filepath.ToSlash(absolute)))
	}
	return guard
}

func (g pathGuard) check(raw string) (string, error) {
	if raw == "" {
		return "", Errorf(CodeInvalidParams, "path is required")
	}
	if strings.ContainsRune(raw, 0) {
		return "", Errorf(CodeInvalidParams, "path may not contain a null byte")
	}
	if !strings.HasPrefix(raw, "/") {
		return "", Errorf(CodeInvalidParams, "path must be absolute: %s", raw)
	}
	for _, segment := range strings.Split(raw, "/") {
		if segment == ".." {
			return "", Errorf(CodeInvalidParams, "path may not traverse upwards: %s", raw)
		}
	}

	// Managed hosts are POSIX, so paths are cleaned with POSIX rules even
	// when the agent itself is running the simulator on another OS.
	cleaned := path.Clean(raw)

	resolved, err := resolveExisting(cleaned)
	if err != nil {
		return "", Errorf(CodeIOError, "cannot resolve %s: %s", cleaned, err.Error())
	}
	if strings.Contains(resolved, "/../") || strings.HasSuffix(resolved, "/..") {
		return "", Errorf(CodePermissionDenied, "path escapes through a symlink: %s", raw)
	}
	for _, denied := range g.denied {
		if within(cleaned, denied) || within(resolved, denied) {
			return "", Errorf(CodePermissionDenied, "path is reserved by the agent: %s", raw)
		}
	}
	return cleaned, nil
}

func (g pathGuard) checkAll(raws []string) ([]string, error) {
	if len(raws) == 0 {
		return nil, Errorf(CodeInvalidParams, "at least one path is required")
	}
	out := make([]string, 0, len(raws))
	for _, raw := range raws {
		cleaned, err := g.check(raw)
		if err != nil {
			return nil, err
		}
		out = append(out, cleaned)
	}
	return out, nil
}

// resolveExisting resolves the symlinks of the deepest part of the path
// that exists, then re-attaches the part that does not. A path being
// created still gets its parents checked.
func resolveExisting(p string) (string, error) {
	current := p
	remainder := ""

	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			return path.Join(filepath.ToSlash(resolved), remainder), nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		parent := path.Dir(current)
		if parent == current {
			return p, nil
		}
		remainder = path.Join(path.Base(current), remainder)
		current = parent
	}
}

func within(candidate, root string) bool {
	return candidate == root || strings.HasPrefix(candidate, root+"/")
}

/* ----------------------------- validation ---------------------------- */

func checkEnum(field, value string, allowed ...string) error {
	for _, option := range allowed {
		if value == option {
			return nil
		}
	}
	return Errorf(CodeInvalidParams, "%s must be one of %s", field, strings.Join(allowed, ", "))
}

func checkEngine(engine string) error {
	return checkEnum("engine", engine, "mysql", "mariadb", "postgres")
}

// checkIdentifier mirrors the contract's `identifier`: a POSIX user,
// group or database name, never anything a shell would look at twice.
func checkIdentifier(field, value string) error {
	if value == "" || len(value) > 63 {
		return Errorf(CodeInvalidParams, "%s must be between 1 and 63 characters", field)
	}
	first := value[0]
	if !(first == '_' || (first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z')) {
		return Errorf(CodeInvalidParams, "%s must start with a letter or underscore", field)
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-':
		default:
			return Errorf(CodeInvalidParams, "%s contains an illegal character", field)
		}
	}
	return nil
}

func checkMode(mode string) error {
	if mode == "" {
		return nil
	}
	if len(mode) < 3 || len(mode) > 4 {
		return Errorf(CodeInvalidParams, "mode must be an octal string like 0644")
	}
	for i := 0; i < len(mode); i++ {
		if mode[i] < '0' || mode[i] > '7' {
			return Errorf(CodeInvalidParams, "mode must be an octal string like 0644")
		}
	}
	return nil
}

func checkUnit(unit string) error {
	if unit == "" || len(unit) > 256 {
		return Errorf(CodeInvalidParams, "unit must be between 1 and 256 characters")
	}
	if strings.ContainsAny(unit, " \t\n\r/") || strings.ContainsRune(unit, 0) {
		return Errorf(CodeInvalidParams, "unit contains an illegal character")
	}
	return nil
}

func checkContainerID(id string) error {
	if id == "" || len(id) > 128 {
		return Errorf(CodeInvalidParams, "id must be between 1 and 128 characters")
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-', c == '.', c == '/':
		default:
			return Errorf(CodeInvalidParams, "id contains an illegal character")
		}
	}
	return nil
}

func checkAddress(address string) error {
	at := strings.IndexByte(address, '@')
	if at <= 0 || at == len(address)-1 || len(address) > 320 {
		return Errorf(CodeInvalidParams, "address must be a valid email address")
	}
	if strings.ContainsAny(address, " \t\n\r") || strings.ContainsRune(address, 0) {
		return Errorf(CodeInvalidParams, "address contains an illegal character")
	}
	return nil
}

func checkTarget(target string) error {
	if target == "" || len(target) > 64 {
		return Errorf(CodeInvalidParams, "target must be an address or CIDR range")
	}
	for i := 0; i < len(target); i++ {
		c := target[i]
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'f', c >= 'A' && c <= 'F', c == '.', c == ':', c == '/':
		default:
			return Errorf(CodeInvalidParams, "target must be an address or CIDR range")
		}
	}
	return nil
}

func checkRepository(repository, passwordRef string) error {
	if repository == "" {
		return Errorf(CodeInvalidParams, "repository is required")
	}
	if passwordRef == "" {
		return Errorf(CodeInvalidParams, "password_ref is required")
	}
	return nil
}

func checkDimensions(cols, rows int) error {
	if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
		return Errorf(CodeInvalidParams, "cols and rows must be between 1 and 1000")
	}
	return nil
}

func orDefaultInt(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}

func orDefaultStr(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
