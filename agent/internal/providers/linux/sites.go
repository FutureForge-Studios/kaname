//go:build linux

package linux

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/user"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Websites.
 *
 * Virtual hosts are rendered from a template rather than assembled from
 * operator-supplied config text: the panel chooses a runtime and a set of
 * names, and this file decides what nginx actually reads. Nothing the
 * control plane sends is written into the config verbatim without
 * validation first.
 *
 * A managed vhost carries its own metadata in a leading comment, which is
 * how site.update can change one field without re-deriving the rest by
 * parsing nginx's grammar.
 * ------------------------------------------------------------------ */

const siteMarker = "# kaname-site: "

var (
	sitesAvailable = "/etc/nginx/sites-available"
	sitesEnabled   = "/etc/nginx/sites-enabled"
	nginxConfD     = "/etc/nginx/conf.d"
)

var (
	serverNameDirective = regexp.MustCompile(`(?m)^\s*server_name\s+([^;]+);`)
	rootDirective       = regexp.MustCompile(`(?m)^\s*root\s+([^;]+);`)
	upstreamPattern     = regexp.MustCompile(`^(?:https?://)?(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+):[0-9]{1,5}(?:/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$`)
	unixUpstreamPattern = regexp.MustCompile(`^unix:/[A-Za-z0-9._/-]+$`)
	phpVersionPattern   = regexp.MustCompile(`^[0-9]+\.[0-9]+$`)
)

// siteMetadata is what site.create recorded, read back so site.update can
// be a merge rather than a rewrite from guesses.
type siteMetadata struct {
	Name           string   `json:"name"`
	ServerNames    []string `json:"server_names"`
	Webroot        string   `json:"webroot"`
	Runtime        string   `json:"runtime"`
	RuntimeVersion string   `json:"runtime_version,omitempty"`
	Upstream       string   `json:"upstream,omitempty"`
	ForceHTTPS     bool     `json:"force_https"`
}

type siteOps struct{ p *provider }

func (o siteOps) List(ctx context.Context) ([]providers.SiteInfo, error) {
	if err := o.p.require(providers.CapNginx); err != nil {
		return nil, err
	}

	dir := configRoot()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if isNotExist(err) {
			return []providers.SiteInfo{}, nil
		}
		return nil, wrapFsError(dir, err)
	}

	sites := make([]providers.SiteInfo, 0, len(entries))
	for _, entry := range entries {
		if ctx.Err() != nil {
			return sites, ctx.Err()
		}
		if entry.IsDir() {
			continue
		}
		full := path.Join(dir, entry.Name())
		raw, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		sites = append(sites, describeSite(entry.Name(), full, string(raw)))
	}

	sortSlice(sites, func(a, b providers.SiteInfo) bool { return a.Name < b.Name })
	return sites, nil
}

func (o siteOps) Create(ctx context.Context, p providers.SiteCreateParams) (providers.SiteConfigResult, error) {
	if err := o.p.require(providers.CapNginx); err != nil {
		return providers.SiteConfigResult{}, err
	}
	if err := checkSiteName(p.Name); err != nil {
		return providers.SiteConfigResult{}, err
	}
	for _, name := range p.ServerNames {
		if err := checkDomain(name); err != nil {
			return providers.SiteConfigResult{}, err
		}
	}
	if err := checkRuntimeVersion(p.Runtime, p.RuntimeVersion); err != nil {
		return providers.SiteConfigResult{}, err
	}
	if err := checkUpstream(p.Runtime, p.Upstream); err != nil {
		return providers.SiteConfigResult{}, err
	}

	target := configPath(p.Name)
	if fileExists(target) {
		return providers.SiteConfigResult{}, fmt.Errorf("site %s already exists: %w", p.Name, providers.ErrConflict)
	}

	if err := os.MkdirAll(p.Webroot, defaultDirMode); err != nil {
		return providers.SiteConfigResult{}, wrapFsError(p.Webroot, err)
	}
	if p.Owner != "" {
		account, err := user.Lookup(p.Owner)
		if err != nil {
			return providers.SiteConfigResult{}, notFound("user %s", p.Owner)
		}
		uid, _ := strconv.Atoi(account.Uid)
		gid, _ := strconv.Atoi(account.Gid)
		if err := os.Chown(p.Webroot, uid, gid); err != nil {
			return providers.SiteConfigResult{}, wrapFsError(p.Webroot, err)
		}
	}

	meta := siteMetadata{
		Name:           p.Name,
		ServerNames:    p.ServerNames,
		Webroot:        p.Webroot,
		Runtime:        p.Runtime,
		RuntimeVersion: p.RuntimeVersion,
		Upstream:       p.Upstream,
		ForceHTTPS:     p.ForceHTTPS,
	}
	if err := o.install(ctx, meta, true); err != nil {
		return providers.SiteConfigResult{}, err
	}
	return providers.SiteConfigResult{ConfigPath: target}, nil
}

func (o siteOps) Update(ctx context.Context, p providers.SiteUpdateParams) (providers.SiteConfigResult, error) {
	if err := o.p.require(providers.CapNginx); err != nil {
		return providers.SiteConfigResult{}, err
	}
	if err := checkSiteName(p.Name); err != nil {
		return providers.SiteConfigResult{}, err
	}

	target := configPath(p.Name)
	raw, err := os.ReadFile(target)
	if err != nil {
		return providers.SiteConfigResult{}, wrapFsError(target, err)
	}
	meta, ok := readMetadata(string(raw))
	if !ok {
		return providers.SiteConfigResult{}, fmt.Errorf("%s was not created by Kaname and will not be rewritten: %w", target, providers.ErrPreconditionFailed)
	}

	if len(p.ServerNames) > 0 {
		for _, name := range p.ServerNames {
			if err := checkDomain(name); err != nil {
				return providers.SiteConfigResult{}, err
			}
		}
		meta.ServerNames = p.ServerNames
	}
	if p.Webroot != "" {
		webroot, err := validatePath(p.Webroot)
		if err != nil {
			return providers.SiteConfigResult{}, err
		}
		meta.Webroot = webroot
	}
	if p.RuntimeVersion != "" {
		if err := checkRuntimeVersion(meta.Runtime, p.RuntimeVersion); err != nil {
			return providers.SiteConfigResult{}, err
		}
		meta.RuntimeVersion = p.RuntimeVersion
	}
	if p.Upstream != "" {
		if err := checkUpstream(meta.Runtime, p.Upstream); err != nil {
			return providers.SiteConfigResult{}, err
		}
		meta.Upstream = p.Upstream
	}
	if p.ForceHTTPS != nil {
		meta.ForceHTTPS = *p.ForceHTTPS
	}

	enabled := isEnabled(p.Name)
	if p.Enabled != nil {
		enabled = *p.Enabled
	}
	if err := o.install(ctx, meta, enabled); err != nil {
		return providers.SiteConfigResult{}, err
	}
	return providers.SiteConfigResult{ConfigPath: target}, nil
}

func (o siteOps) Remove(ctx context.Context, p providers.SiteRemoveParams) error {
	if err := o.p.require(providers.CapNginx); err != nil {
		return err
	}
	if err := checkSiteName(p.Name); err != nil {
		return err
	}

	target := configPath(p.Name)
	raw, err := os.ReadFile(target)
	if err != nil {
		return wrapFsError(target, err)
	}
	meta, managed := readMetadata(string(raw))

	if err := os.Remove(enabledPath(p.Name)); err != nil && !isNotExist(err) {
		return wrapFsError(enabledPath(p.Name), err)
	}
	if err := os.Remove(target); err != nil && !isNotExist(err) {
		return wrapFsError(target, err)
	}

	if p.DeleteWebroot && managed && meta.Webroot != "" {
		if _, protected := protectedRoots[meta.Webroot]; protected {
			return fmt.Errorf("%s is protected from recursive deletion: %w", meta.Webroot, providers.ErrPermissionDenied)
		}
		if err := os.RemoveAll(meta.Webroot); err != nil {
			return wrapFsError(meta.Webroot, err)
		}
	}
	return o.Reload(ctx)
}

func (o siteOps) TestConfig(ctx context.Context) (providers.SiteTestConfigResult, error) {
	if err := o.p.require(providers.CapNginx); err != nil {
		return providers.SiteTestConfigResult{}, err
	}

	// nginx -t writes its verdict to stderr in both the pass and fail
	// case, so the operator sees the same text either way.
	out, err := runCombined(ctx, execOptions{Name: "nginx", Args: []string{"-t"}, Env: cLocale()})
	if err != nil {
		var failure *providers.ExecError
		if errors.As(err, &failure) {
			return providers.SiteTestConfigResult{Valid: false, Output: failure.Output}, nil
		}
		return providers.SiteTestConfigResult{}, err
	}
	return providers.SiteTestConfigResult{Valid: true, Output: strings.TrimSpace(out)}, nil
}

func (o siteOps) Reload(ctx context.Context) error {
	if err := o.p.require(providers.CapNginx); err != nil {
		return err
	}

	// Validating first is what stops a bad vhost from taking every site on
	// the host down with it.
	verdict, err := o.TestConfig(ctx)
	if err != nil {
		return err
	}
	if !verdict.Valid {
		return &providers.ExecError{Op: "nginx -t", Output: verdict.Output, Err: providers.ErrPreconditionFailed}
	}

	if o.p.has(providers.CapSystemd) {
		_, err := runWith(ctx, execOptions{Name: "systemctl", Args: []string{"reload", "nginx"}, Env: cLocale()})
		return err
	}
	_, err = runWith(ctx, execOptions{Name: "nginx", Args: []string{"-s", "reload"}, Env: cLocale()})
	return err
}

/* ------------------------------ rendering ---------------------------- */

// install writes the vhost, points sites-enabled at it (or does not), and
// only reloads once nginx has accepted the result. A config that fails
// validation is rolled back rather than left in place.
func (o siteOps) install(ctx context.Context, meta siteMetadata, enabled bool) error {
	target := configPath(meta.Name)
	previous, previousErr := os.ReadFile(target)

	rendered, err := renderSite(meta)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(path.Dir(target), defaultDirMode); err != nil {
		return wrapFsError(path.Dir(target), err)
	}
	if err := writeAtomic(target, []byte(rendered), 0o644); err != nil {
		return err
	}

	if err := o.setEnabled(meta.Name, enabled); err != nil {
		return err
	}

	if err := o.Reload(ctx); err != nil {
		if previousErr == nil {
			_ = writeAtomic(target, previous, 0o644)
		} else {
			_ = os.Remove(target)
			_ = os.Remove(enabledPath(meta.Name))
		}
		return err
	}
	return nil
}

func (o siteOps) setEnabled(name string, enabled bool) error {
	if !dirExists(sitesEnabled) {
		// Single-directory layouts (conf.d) have no enable step; the file
		// existing is what enables the site.
		return nil
	}

	link := enabledPath(name)
	if !enabled {
		if err := os.Remove(link); err != nil && !isNotExist(err) {
			return wrapFsError(link, err)
		}
		return nil
	}
	if _, err := os.Lstat(link); err == nil {
		return nil
	}
	if err := os.Symlink(configPath(name), link); err != nil {
		return wrapFsError(link, err)
	}
	return nil
}

func renderSite(meta siteMetadata) (string, error) {
	if len(meta.ServerNames) == 0 {
		return "", invalid("a virtual host needs at least one server name")
	}
	encoded, err := json.Marshal(meta)
	if err != nil {
		return "", fmt.Errorf("encode site metadata: %w", err)
	}

	names := strings.Join(meta.ServerNames, " ")
	chain, key := certificatePaths(meta.ServerNames[0])
	secure := meta.ForceHTTPS && chain != "" && key != ""

	var b strings.Builder
	b.WriteString(siteMarker)
	b.Write(encoded)
	b.WriteString("\n# Managed by Kaname. Edits are overwritten on the next site update.\n\n")

	if secure {
		fmt.Fprintf(&b, "server {\n    listen 80;\n    listen [::]:80;\n    server_name %s;\n", names)
		b.WriteString("    location /.well-known/acme-challenge/ { root " + meta.Webroot + "; }\n")
		b.WriteString("    location / { return 301 https://$host$request_uri; }\n}\n\n")

		fmt.Fprintf(&b, "server {\n    listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;\n    server_name %s;\n", names)
		fmt.Fprintf(&b, "    ssl_certificate %s;\n    ssl_certificate_key %s;\n", chain, key)
		b.WriteString("    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_prefer_server_ciphers off;\n")
	} else {
		fmt.Fprintf(&b, "server {\n    listen 80;\n    listen [::]:80;\n    server_name %s;\n", names)
	}

	fmt.Fprintf(&b, "    root %s;\n    index index.html index.htm;\n", meta.Webroot)
	b.WriteString("    access_log /var/log/nginx/" + meta.Name + ".access.log;\n")
	b.WriteString("    error_log /var/log/nginx/" + meta.Name + ".error.log;\n")
	b.WriteString("    client_max_body_size 64m;\n\n")

	switch meta.Runtime {
	case "static":
		b.WriteString("    location / {\n        try_files $uri $uri/ =404;\n    }\n")

	case "php":
		socket := phpSocket(meta.RuntimeVersion)
		b.WriteString("    index index.php index.html;\n")
		b.WriteString("    location / {\n        try_files $uri $uri/ /index.php?$query_string;\n    }\n")
		b.WriteString("    location ~ \\.php$ {\n")
		b.WriteString("        include fastcgi_params;\n")
		b.WriteString("        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;\n")
		fmt.Fprintf(&b, "        fastcgi_pass unix:%s;\n", socket)
		b.WriteString("    }\n")
		b.WriteString("    location ~ /\\.(?!well-known).* { deny all; }\n")

	case "node", "python", "proxy", "container":
		b.WriteString("    location / {\n")
		fmt.Fprintf(&b, "        proxy_pass %s;\n", normalizeUpstream(meta.Upstream))
		b.WriteString("        proxy_http_version 1.1;\n")
		b.WriteString("        proxy_set_header Host $host;\n")
		b.WriteString("        proxy_set_header X-Real-IP $remote_addr;\n")
		b.WriteString("        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n")
		b.WriteString("        proxy_set_header X-Forwarded-Proto $scheme;\n")
		b.WriteString("        proxy_set_header Upgrade $http_upgrade;\n")
		b.WriteString("        proxy_set_header Connection \"upgrade\";\n")
		b.WriteString("        proxy_read_timeout 300s;\n")
		b.WriteString("    }\n")

	default:
		return "", invalid("runtime %q is not supported", meta.Runtime)
	}

	b.WriteString("}\n")
	return b.String(), nil
}

/* ------------------------------- reading ----------------------------- */

func describeSite(name, configPath, raw string) providers.SiteInfo {
	if meta, ok := readMetadata(raw); ok {
		info := providers.SiteInfo{
			Name:        meta.Name,
			Webroot:     meta.Webroot,
			ServerNames: meta.ServerNames,
			Runtime:     meta.Runtime,
			Enabled:     isEnabled(meta.Name),
			ConfigPath:  configPath,
		}
		if meta.RuntimeVersion != "" {
			info.RuntimeVersion = stringPtr(meta.RuntimeVersion)
		}
		return info
	}

	// A vhost Kaname did not write still deserves a row, derived from the
	// two directives that are unambiguous to read.
	info := providers.SiteInfo{
		Name:        strings.TrimSuffix(name, ".conf"),
		ServerNames: []string{},
		Runtime:     "static",
		Enabled:     isEnabled(strings.TrimSuffix(name, ".conf")),
		ConfigPath:  configPath,
	}
	if match := serverNameDirective.FindStringSubmatch(raw); len(match) == 2 {
		info.ServerNames = strings.Fields(match[1])
	}
	if match := rootDirective.FindStringSubmatch(raw); len(match) == 2 {
		info.Webroot = strings.TrimSpace(match[1])
	}
	if strings.Contains(raw, "fastcgi_pass") {
		info.Runtime = "php"
	} else if strings.Contains(raw, "proxy_pass") {
		info.Runtime = "proxy"
	}
	return info
}

func readMetadata(raw string) (siteMetadata, bool) {
	for _, line := range strings.SplitN(raw, "\n", 4) {
		if !strings.HasPrefix(line, siteMarker) {
			continue
		}
		var meta siteMetadata
		if err := json.Unmarshal([]byte(strings.TrimPrefix(line, siteMarker)), &meta); err != nil {
			return siteMetadata{}, false
		}
		return meta, meta.Name != ""
	}
	return siteMetadata{}, false
}

func configRoot() string {
	if dirExists(sitesAvailable) {
		return sitesAvailable
	}
	return nginxConfD
}

func configPath(name string) string {
	return path.Join(configRoot(), name+".conf")
}

func enabledPath(name string) string {
	return path.Join(sitesEnabled, name+".conf")
}

func isEnabled(name string) bool {
	if !dirExists(sitesEnabled) {
		return fileExists(configPath(name))
	}
	_, err := os.Lstat(enabledPath(name))
	return err == nil
}

// phpSocket picks the FPM socket for a version, falling back to whatever
// single socket the host happens to have.
func phpSocket(version string) string {
	if version != "" {
		return "/run/php/php" + version + "-fpm.sock"
	}
	for _, candidate := range []string{"/run/php/php-fpm.sock", "/run/php-fpm/www.sock", "/var/run/php-fpm/www.sock"} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "/run/php/php-fpm.sock"
}

func normalizeUpstream(upstream string) string {
	if strings.HasPrefix(upstream, "http://") || strings.HasPrefix(upstream, "https://") || strings.HasPrefix(upstream, "unix:") {
		return upstream
	}
	return "http://" + upstream
}

/* ------------------------------ validation --------------------------- */

func checkSiteName(name string) error {
	if name == "" || len(name) > 128 {
		return invalid("site name must be between 1 and 128 characters")
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '.', c == '-', c == '_':
		default:
			return invalid("site name contains an illegal character")
		}
	}
	if strings.HasPrefix(name, ".") {
		return invalid("site name may not start with a dot")
	}
	return nil
}

func checkRuntimeVersion(runtime, version string) error {
	if version == "" {
		return nil
	}
	if runtime == "php" && !phpVersionPattern.MatchString(version) {
		return invalid("php version must look like 8.3")
	}
	for i := 0; i < len(version); i++ {
		c := version[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '.', c == '-':
		default:
			return invalid("runtime version contains an illegal character")
		}
	}
	return nil
}

// checkUpstream refuses anything that is not a host:port or unix socket,
// because the value is written into a proxy_pass directive.
func checkUpstream(runtime, upstream string) error {
	needsUpstream := runtime == "node" || runtime == "python" || runtime == "proxy" || runtime == "container"
	if upstream == "" {
		if needsUpstream {
			return invalid("runtime %s needs an upstream", runtime)
		}
		return nil
	}
	if !needsUpstream {
		return invalid("runtime %s does not take an upstream", runtime)
	}
	if unixUpstreamPattern.MatchString(upstream) || upstreamPattern.MatchString(upstream) {
		return nil
	}
	return invalid("upstream must be host:port, http://host:port or unix:/path")
}
