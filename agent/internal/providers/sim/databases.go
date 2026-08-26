package sim

import (
	"context"
	"fmt"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Databases.
 *
 * Two engines, because the panel has to prove it can hold both at once:
 * a PostgreSQL 16 cluster carrying the applications, and a MariaDB
 * instance carrying the legacy blog. Creating a database or a user
 * really adds one, and dropping one really removes it — including the
 * grants that pointed at it, which is the part a naive fake forgets.
 * ------------------------------------------------------------------ */

const (
	enginePostgres = "postgres"
	engineMariaDB  = "mariadb"
	engineMySQL    = "mysql"
)

func (s *Sim) buildDatabases() {
	s.databases = map[string][]*providers.DbDatabaseInfo{}
	s.dbUsers = map[string][]*providers.DbUserInfo{}
	s.dbGrants = map[string][]string{}

	postgres := []struct {
		name   string
		owner  string
		size   int64
		tables int
	}{
		{"kaname", "kaname", 1_884_301_824, 42},
		{"storefront", "storefront", 6_442_450_944, 118},
		{"analytics", "analytics", 21_474_836_480, 27},
		{"uptime_kuma", "kaname", 184_549_376, 19},
		{"n8n", "kaname", 512_802_816, 34},
		{"postgres", "postgres", 8_495_104, 0},
	}
	for _, db := range postgres {
		s.databases[enginePostgres] = append(s.databases[enginePostgres], &providers.DbDatabaseInfo{
			Name:       db.name,
			Owner:      ptr(db.owner),
			Encoding:   "UTF8",
			Collation:  ptr("en_US.UTF-8"),
			SizeBytes:  db.size,
			TableCount: db.tables,
		})
	}

	mariadb := []struct {
		name   string
		size   int64
		tables int
	}{
		{"blog_prod", 3_221_225_472, 64},
		{"blog_staging", 486_539_264, 64},
		{"legacy_crm", 12_884_901_888, 211},
	}
	for _, db := range mariadb {
		s.databases[engineMariaDB] = append(s.databases[engineMariaDB], &providers.DbDatabaseInfo{
			Name:       db.name,
			Owner:      ptr("root"),
			Encoding:   "utf8mb4",
			Collation:  ptr("utf8mb4_general_ci"),
			SizeBytes:  db.size,
			TableCount: db.tables,
		})
	}

	s.dbUsers[enginePostgres] = []*providers.DbUserInfo{
		{Username: "postgres", HostPattern: "localhost", AuthPlugin: ptr("scram-sha-256"), IsSuperuser: true, CanLogin: true},
		{Username: "kaname", HostPattern: "localhost", AuthPlugin: ptr("scram-sha-256"), CanLogin: true},
		{Username: "storefront", HostPattern: "localhost", AuthPlugin: ptr("scram-sha-256"), CanLogin: true},
		{Username: "analytics", HostPattern: "localhost", AuthPlugin: ptr("scram-sha-256"), CanLogin: true},
		{Username: "readonly", HostPattern: "localhost", AuthPlugin: ptr("scram-sha-256"), CanLogin: true},
		{Username: "replication", HostPattern: "10.20.30.0/24", AuthPlugin: ptr("scram-sha-256"), CanLogin: false},
	}
	s.dbUsers[engineMariaDB] = []*providers.DbUserInfo{
		{Username: "root", HostPattern: "localhost", AuthPlugin: ptr("unix_socket"), IsSuperuser: true, CanLogin: true},
		{Username: "blog", HostPattern: "localhost", AuthPlugin: ptr("mysql_native_password"), CanLogin: true},
		{Username: "backup", HostPattern: "%", AuthPlugin: ptr("mysql_native_password"), CanLogin: true},
	}

	for _, grant := range []struct {
		engine     string
		database   string
		user       string
		host       string
		privileges []string
	}{
		{enginePostgres, "kaname", "kaname", "localhost", []string{"ALL"}},
		{enginePostgres, "storefront", "storefront", "localhost", []string{"ALL"}},
		{enginePostgres, "analytics", "analytics", "localhost", []string{"ALL"}},
		{enginePostgres, "analytics", "readonly", "localhost", []string{"SELECT"}},
		{enginePostgres, "storefront", "readonly", "localhost", []string{"SELECT"}},
		{engineMariaDB, "blog_prod", "blog", "localhost", []string{"SELECT", "INSERT", "UPDATE", "DELETE"}},
		{engineMariaDB, "blog_staging", "blog", "localhost", []string{"ALL"}},
		{engineMariaDB, "legacy_crm", "backup", "%", []string{"SELECT"}},
	} {
		s.dbGrants[grantKey(grant.engine, grant.database, grant.user, grant.host)] = grant.privileges
	}
}

func grantKey(engine, database, user, host string) string {
	return strings.Join([]string{engine, database, user, host}, "|")
}

// normaliseEngine folds mysql onto mariadb: the host runs one of them,
// and a panel configured for either should reach it.
func normaliseEngine(engine string) string {
	if engine == engineMySQL {
		return engineMariaDB
	}
	return engine
}

/* ----------------------------- databases ----------------------------- */

type simDatabases struct{ *Sim }

func (s simDatabases) Instances(context.Context) ([]providers.DbInstanceInfo, error) {
	now := time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()

	uptime := int64(now.Sub(s.bootTime).Seconds())
	instances := []providers.DbInstanceInfo{
		{
			Engine: enginePostgres, Version: "16.3 (Debian 16.3-1.pgdg120+1)",
			Host: "127.0.0.1", Port: 5432, Reachable: s.unitActiveLocked("postgresql@16-main.service"),
			UptimeSeconds: ptr(uptime), Connections: ptr(11 + int(mix(s.seed^0xd1)%14)), MaxConnections: ptr(100),
			DataSize: ptr(sumSizesLocked(s.databases[enginePostgres])),
		},
		{
			Engine: engineMariaDB, Version: "10.11.6-MariaDB-0+deb12u1",
			Host: "127.0.0.1", Port: 3306, Reachable: s.unitActiveLocked("mariadb.service"),
			UptimeSeconds: ptr(uptime), Connections: ptr(3 + int(mix(s.seed^0xd2)%9)), MaxConnections: ptr(151),
			DataSize: ptr(sumSizesLocked(s.databases[engineMariaDB])),
		},
	}
	return instances, nil
}

func sumSizesLocked(databases []*providers.DbDatabaseInfo) int64 {
	var total int64
	for _, db := range databases {
		total += db.SizeBytes
	}
	return total
}

func (s *Sim) findDatabaseLocked(engine, name string) *providers.DbDatabaseInfo {
	for _, db := range s.databases[normaliseEngine(engine)] {
		if db.Name == name {
			return db
		}
	}
	return nil
}

func (s *Sim) findDbUserLocked(engine, username, host string) *providers.DbUserInfo {
	for _, user := range s.dbUsers[normaliseEngine(engine)] {
		if user.Username == username && (host == "" || user.HostPattern == host) {
			return user
		}
	}
	return nil
}

func (s simDatabases) ListDatabases(_ context.Context, p providers.DbEngineParams) ([]providers.DbDatabaseInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.DbDatabaseInfo, 0, len(s.databases[normaliseEngine(p.Engine)]))
	for _, db := range s.databases[normaliseEngine(p.Engine)] {
		out = append(out, *db)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func (s simDatabases) CreateDatabase(_ context.Context, p providers.DbDatabaseCreateParams) (providers.DbDatabaseInfo, error) {
	engine := normaliseEngine(p.Engine)

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.findDatabaseLocked(engine, p.Name) != nil {
		return providers.DbDatabaseInfo{}, fmt.Errorf("database %s already exists: %w", p.Name, providers.ErrConflict)
	}

	encoding, collation := "UTF8", "en_US.UTF-8"
	if engine == engineMariaDB {
		encoding, collation = "utf8mb4", "utf8mb4_general_ci"
	}
	if p.Encoding != "" {
		encoding = p.Encoding
	}
	if p.Collation != "" {
		collation = p.Collation
	}

	owner := p.Owner
	if owner == "" {
		owner = map[string]string{enginePostgres: "postgres", engineMariaDB: "root"}[engine]
	}

	db := &providers.DbDatabaseInfo{
		Name:      p.Name,
		Owner:     ptr(owner),
		Encoding:  encoding,
		Collation: ptr(collation),
		SizeBytes: 8_495_104,
	}
	s.databases[engine] = append(s.databases[engine], db)
	return *db, nil
}

func (s simDatabases) DeleteDatabase(_ context.Context, p providers.DbDatabaseDeleteParams) error {
	engine := normaliseEngine(p.Engine)

	s.mu.Lock()
	defer s.mu.Unlock()

	index := -1
	for i, db := range s.databases[engine] {
		if db.Name == p.Name {
			index = i
			break
		}
	}
	if index < 0 {
		return fmt.Errorf("database %s: %w", p.Name, providers.ErrNotFound)
	}
	s.databases[engine] = append(s.databases[engine][:index], s.databases[engine][index+1:]...)

	// Grants that pointed at the dropped database go with it; leaving them
	// behind is how a panel ends up showing privileges on nothing.
	prefix := engine + "|" + p.Name + "|"
	for key := range s.dbGrants {
		if strings.HasPrefix(key, prefix) {
			delete(s.dbGrants, key)
		}
	}
	return nil
}

func (s simDatabases) ListUsers(_ context.Context, p providers.DbEngineParams) ([]providers.DbUserInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]providers.DbUserInfo, 0, len(s.dbUsers[normaliseEngine(p.Engine)]))
	for _, user := range s.dbUsers[normaliseEngine(p.Engine)] {
		out = append(out, *user)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Username < out[j].Username })
	return out, nil
}

func (s simDatabases) CreateUser(_ context.Context, p providers.DbUserCreateParams) (providers.DbUserInfo, error) {
	engine := normaliseEngine(p.Engine)

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.findDbUserLocked(engine, p.Username, p.HostPattern) != nil {
		return providers.DbUserInfo{}, fmt.Errorf("user %s already exists: %w", p.Username, providers.ErrConflict)
	}

	plugin := "scram-sha-256"
	if engine == engineMariaDB {
		plugin = "mysql_native_password"
	}
	user := &providers.DbUserInfo{
		Username:    p.Username,
		HostPattern: p.HostPattern,
		AuthPlugin:  ptr(plugin),
		CanLogin:    true,
	}
	s.dbUsers[engine] = append(s.dbUsers[engine], user)
	return *user, nil
}

func (s simDatabases) UpdateUser(_ context.Context, p providers.DbUserUpdateParams) (providers.DbUserInfo, error) {
	engine := normaliseEngine(p.Engine)

	s.mu.Lock()
	defer s.mu.Unlock()

	user := s.findDbUserLocked(engine, p.Username, p.HostPattern)
	if user == nil {
		return providers.DbUserInfo{}, fmt.Errorf("user %s: %w", p.Username, providers.ErrNotFound)
	}
	if p.CanLogin != nil {
		user.CanLogin = *p.CanLogin
	}
	return *user, nil
}

func (s simDatabases) DeleteUser(_ context.Context, p providers.DbUserDeleteParams) error {
	engine := normaliseEngine(p.Engine)

	s.mu.Lock()
	defer s.mu.Unlock()

	index := -1
	for i, user := range s.dbUsers[engine] {
		if user.Username == p.Username && user.HostPattern == p.HostPattern {
			index = i
			break
		}
	}
	if index < 0 {
		return fmt.Errorf("user %s@%s: %w", p.Username, p.HostPattern, providers.ErrNotFound)
	}
	if s.dbUsers[engine][index].IsSuperuser {
		return fmt.Errorf("refusing to drop the superuser %s: %w", p.Username, providers.ErrPermissionDenied)
	}
	s.dbUsers[engine] = append(s.dbUsers[engine][:index], s.dbUsers[engine][index+1:]...)

	suffix := "|" + p.Username + "|" + p.HostPattern
	for key := range s.dbGrants {
		if strings.HasSuffix(key, suffix) {
			delete(s.dbGrants, key)
		}
	}
	return nil
}

func (s simDatabases) ApplyGrant(_ context.Context, p providers.DbGrantApplyParams) error {
	engine := normaliseEngine(p.Engine)

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.findDatabaseLocked(engine, p.Database) == nil {
		return fmt.Errorf("database %s: %w", p.Database, providers.ErrNotFound)
	}
	if s.findDbUserLocked(engine, p.Username, p.HostPattern) == nil {
		return fmt.Errorf("user %s@%s: %w", p.Username, p.HostPattern, providers.ErrNotFound)
	}

	key := grantKey(engine, p.Database, p.Username, p.HostPattern)
	if len(p.Privileges) == 0 {
		delete(s.dbGrants, key)
		return nil
	}

	privileges := make([]string, 0, len(p.Privileges))
	for _, privilege := range p.Privileges {
		privileges = append(privileges, strings.ToUpper(privilege))
	}
	sort.Strings(privileges)
	s.dbGrants[key] = privileges
	return nil
}

func (s simDatabases) Size(_ context.Context, p providers.DbSizeParams) (providers.DbSizeResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	db := s.findDatabaseLocked(p.Engine, p.Name)
	if db == nil {
		return providers.DbSizeResult{}, fmt.Errorf("database %s: %w", p.Name, providers.ErrNotFound)
	}
	return providers.DbSizeResult{SizeBytes: db.SizeBytes, TableCount: db.TableCount}, nil
}

func (s simDatabases) Dump(ctx context.Context, p providers.DbDumpParams, stream providers.Stream) (providers.DbDumpResult, error) {
	destination, err := cleanPath(p.Destination)
	if err != nil {
		return providers.DbDumpResult{}, err
	}
	engine := normaliseEngine(p.Engine)

	s.mu.Lock()
	db := s.findDatabaseLocked(engine, p.Name)
	if db == nil {
		s.mu.Unlock()
		return providers.DbDumpResult{}, fmt.Errorf("database %s: %w", p.Name, providers.ErrNotFound)
	}
	logical, tables := db.SizeBytes, db.TableCount
	s.mu.Unlock()

	tool := "pg_dump"
	if engine == engineMariaDB {
		tool = "mariadb-dump"
	}

	if err := progress(ctx, stream, 0, "%s: dumping database %q to %s", tool, p.Name, destination); err != nil {
		return providers.DbDumpResult{}, err
	}
	for i := 0; i < tables && i < 12; i++ {
		if err := progress(ctx, stream, 110*time.Millisecond, "%s: dumping contents of table \"public.%s\"", tool, dumpTableName(engine, i)); err != nil {
			return providers.DbDumpResult{}, err
		}
	}

	size := logical / 4
	if p.Compress {
		size = logical / 11
	}

	s.fs.mu.Lock()
	s.fs.mkdirAllLocked(path.Dir(destination))
	parent, err := s.fs.parentOf(destination)
	if err != nil {
		s.fs.mu.Unlock()
		return providers.DbDumpResult{}, err
	}
	parent.children[path.Base(destination)] = &node{
		name: path.Base(destination), kind: "file", mode: "0640",
		owner: "root", group: "root", modified: time.Now().UTC(), virtual: size,
	}
	s.fs.mu.Unlock()
	s.accountBytes(size)

	_ = progress(ctx, stream, 0, "%s: wrote %s (%d bytes, %d tables)", tool, destination, size, tables)
	return providers.DbDumpResult{Path: destination, SizeBytes: size}, nil
}

func dumpTableName(engine string, index int) string {
	tables := []string{
		"users", "sessions", "orders", "order_items", "products", "inventory",
		"audit_events", "jobs", "job_logs", "settings", "migrations", "carts",
	}
	if engine == engineMariaDB {
		tables = []string{
			"wp_posts", "wp_postmeta", "wp_options", "wp_users", "wp_usermeta",
			"wp_terms", "wp_term_taxonomy", "wp_comments", "wp_commentmeta",
			"wp_links", "wp_termmeta", "wp_term_relationships",
		}
	}
	return tables[index%len(tables)]
}

func (s simDatabases) Restore(ctx context.Context, p providers.DbRestoreParams, stream providers.Stream) error {
	source, err := cleanPath(p.Source)
	if err != nil {
		return err
	}
	engine := normaliseEngine(p.Engine)

	s.fs.mu.RLock()
	dump, _, err := s.fs.lookup(source, true)
	s.fs.mu.RUnlock()
	if err != nil {
		return err
	}
	size := dump.size()

	tool := "psql"
	if engine == engineMariaDB {
		tool = "mariadb"
	}

	s.mu.Lock()
	db := s.findDatabaseLocked(engine, p.Name)
	if db == nil {
		if !p.DropExisting {
			s.mu.Unlock()
			return fmt.Errorf("database %s: %w", p.Name, providers.ErrNotFound)
		}
		db = &providers.DbDatabaseInfo{Name: p.Name, Owner: ptr("postgres"), Encoding: "UTF8", Collation: ptr("en_US.UTF-8")}
		s.databases[engine] = append(s.databases[engine], db)
	}
	s.mu.Unlock()

	steps := []string{
		fmt.Sprintf("%s: restoring %s into %q", tool, source, p.Name),
	}
	if p.DropExisting {
		steps = append(steps, fmt.Sprintf("%s: DROP DATABASE IF EXISTS %s", tool, p.Name), fmt.Sprintf("%s: CREATE DATABASE %s", tool, p.Name))
	}
	steps = append(steps,
		tool+": creating schema \"public\"",
		tool+": restoring data",
		tool+": creating indexes",
		tool+": restoring constraints",
	)
	for _, step := range steps {
		if err := progress(ctx, stream, 220*time.Millisecond, "%s", step); err != nil {
			return err
		}
	}

	s.mu.Lock()
	db.SizeBytes = size * 4
	db.TableCount = 12 + int(mix(s.seed^hashString(p.Name))%60)
	s.mu.Unlock()

	_ = progress(ctx, stream, 0, "%s: restore complete", tool)
	return nil
}
