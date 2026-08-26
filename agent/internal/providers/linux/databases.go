//go:build linux

package linux

import (
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"

	"github.com/futureforge/kaname/agent/internal/providers"
)

/* ------------------------------------------------------------------ *
 * Databases.
 *
 * The engines are driven through their own CLI clients, and every
 * statement travels on stdin rather than in `-e`: a password in an argv
 * is a password every user on the host can read out of /proc.
 *
 * Identifiers arrive already validated by the RPC layer and are quoted
 * again here — backticks for MySQL, double quotes for PostgreSQL — so a
 * name can never break out of its position in a statement.
 * ------------------------------------------------------------------ */

const (
	// Field separator for psql's unaligned output. A unit separator cannot
	// appear in an identifier, so splitting on it is unambiguous.
	psqlSeparator = "\x1f"
	// How much dump output goes by before the operator gets a progress line.
	dumpProgressStride = 8 << 20
)

// Schemas that belong to the engine rather than to the operator.
var systemSchemas = map[string]struct{}{
	"information_schema": {}, "mysql": {}, "performance_schema": {}, "sys": {},
	"template0": {}, "template1": {},
}

type databaseOps struct{ p *provider }

/* ------------------------------ instances ---------------------------- */

func (o databaseOps) Instances(ctx context.Context) ([]providers.DbInstanceInfo, error) {
	instances := make([]providers.DbInstanceInfo, 0, 2)

	if o.p.has(providers.CapMySQL) || o.p.has(providers.CapMariaDB) {
		engine := "mysql"
		if o.p.has(providers.CapMariaDB) && !o.p.has(providers.CapMySQL) {
			engine = "mariadb"
		}
		instances = append(instances, o.mysqlInstance(ctx, engine))
	}
	if o.p.has(providers.CapPostgres) {
		instances = append(instances, o.postgresInstance(ctx))
	}
	if len(instances) == 0 {
		return nil, unsupported("no database client is installed on this host")
	}
	return instances, nil
}

func (o databaseOps) mysqlInstance(ctx context.Context, engine string) providers.DbInstanceInfo {
	instance := providers.DbInstanceInfo{Engine: engine, Host: "localhost", Port: 3306}

	rows, err := o.mysql(ctx, "", strings.Join([]string{
		"SELECT VERSION();",
		"SHOW GLOBAL STATUS LIKE 'Uptime';",
		"SHOW GLOBAL STATUS LIKE 'Threads_connected';",
		"SHOW GLOBAL VARIABLES LIKE 'max_connections';",
		"SHOW GLOBAL VARIABLES LIKE 'port';",
		"SELECT COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0) FROM information_schema.TABLES;",
	}, "\n"))
	if err != nil {
		return instance
	}

	instance.Reachable = true
	for index, row := range rows {
		switch {
		case index == 0 && len(row) > 0:
			instance.Version = row[0]
		case len(row) == 2:
			value, err := strconv.ParseInt(row[1], 10, 64)
			if err != nil {
				continue
			}
			switch row[0] {
			case "Uptime":
				instance.UptimeSeconds = int64Ptr(value)
			case "Threads_connected":
				count := int(value)
				instance.Connections = &count
			case "max_connections":
				count := int(value)
				instance.MaxConnections = &count
			case "port":
				instance.Port = int(value)
			}
		case len(row) == 1:
			if value, err := strconv.ParseInt(row[0], 10, 64); err == nil {
				instance.DataSize = int64Ptr(value)
			}
		}
	}
	return instance
}

func (o databaseOps) postgresInstance(ctx context.Context) providers.DbInstanceInfo {
	instance := providers.DbInstanceInfo{Engine: "postgres", Host: "localhost", Port: 5432}

	// One statement per line, so the answers come back in a known order.
	rows, err := o.psql(ctx, "postgres", strings.Join([]string{
		"SELECT current_setting('server_version');",
		"SELECT current_setting('port');",
		"SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint;",
		"SELECT count(*) FROM pg_stat_activity;",
		"SELECT current_setting('max_connections');",
		"SELECT COALESCE(sum(pg_database_size(datname)),0)::bigint FROM pg_database;",
	}, "\n"))
	if err != nil || len(rows) < 6 {
		return instance
	}

	instance.Reachable = true
	instance.Version = first(rows[0])
	if port, err := strconv.Atoi(first(rows[1])); err == nil {
		instance.Port = port
	}
	if uptime, err := strconv.ParseInt(first(rows[2]), 10, 64); err == nil {
		instance.UptimeSeconds = int64Ptr(uptime)
	}
	if connections, err := strconv.Atoi(first(rows[3])); err == nil {
		instance.Connections = &connections
	}
	if maximum, err := strconv.Atoi(first(rows[4])); err == nil {
		instance.MaxConnections = &maximum
	}
	if size, err := strconv.ParseInt(first(rows[5]), 10, 64); err == nil {
		instance.DataSize = int64Ptr(size)
	}
	return instance
}

/* ------------------------------ databases ---------------------------- */

func (o databaseOps) ListDatabases(ctx context.Context, p providers.DbEngineParams) ([]providers.DbDatabaseInfo, error) {
	if isPostgres(p.Engine) {
		rows, err := o.psql(ctx, "postgres", strings.Join([]string{
			"SELECT d.datname, pg_get_userbyid(d.datdba), pg_encoding_to_char(d.encoding),",
			"       d.datcollate, pg_database_size(d.datname)::bigint",
			"FROM pg_database d WHERE NOT d.datistemplate ORDER BY d.datname;",
		}, "\n"))
		if err != nil {
			return nil, err
		}

		databases := make([]providers.DbDatabaseInfo, 0, len(rows))
		for _, row := range rows {
			if len(row) < 5 {
				continue
			}
			size, _ := strconv.ParseInt(row[4], 10, 64)
			info := providers.DbDatabaseInfo{
				Name:      row[0],
				Owner:     stringPtr(row[1]),
				Encoding:  row[2],
				Collation: stringPtr(row[3]),
				SizeBytes: size,
			}
			info.TableCount = o.postgresTableCount(ctx, row[0])
			databases = append(databases, info)
		}
		return databases, nil
	}

	rows, err := o.mysql(ctx, "", strings.Join([]string{
		"SELECT s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME,",
		"       COALESCE(SUM(t.DATA_LENGTH+t.INDEX_LENGTH),0), COUNT(t.TABLE_NAME)",
		"FROM information_schema.SCHEMATA s",
		"LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME",
		"GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME",
		"ORDER BY s.SCHEMA_NAME;",
	}, "\n"))
	if err != nil {
		return nil, err
	}

	databases := make([]providers.DbDatabaseInfo, 0, len(rows))
	for _, row := range rows {
		if len(row) < 5 {
			continue
		}
		if _, system := systemSchemas[row[0]]; system {
			continue
		}
		size, _ := strconv.ParseInt(row[3], 10, 64)
		tables, _ := strconv.Atoi(row[4])
		databases = append(databases, providers.DbDatabaseInfo{
			Name:       row[0],
			Encoding:   row[1],
			Collation:  stringPtr(row[2]),
			SizeBytes:  size,
			TableCount: tables,
		})
	}
	return databases, nil
}

func (o databaseOps) CreateDatabase(ctx context.Context, p providers.DbDatabaseCreateParams) (providers.DbDatabaseInfo, error) {
	if isPostgres(p.Engine) {
		statement := "CREATE DATABASE " + quotePG(p.Name)
		if p.Encoding != "" {
			if err := checkCharset(p.Encoding); err != nil {
				return providers.DbDatabaseInfo{}, err
			}
			statement += " ENCODING " + literal(p.Encoding)
		}
		if p.Collation != "" {
			if err := checkCharset(p.Collation); err != nil {
				return providers.DbDatabaseInfo{}, err
			}
			// A non-default collation needs template0; template1 carries the
			// cluster's own locale and would reject it.
			statement += " LC_COLLATE " + literal(p.Collation) + " TEMPLATE template0"
		}
		if p.Owner != "" {
			statement += " OWNER " + quotePG(p.Owner)
		}
		if _, err := o.psql(ctx, "postgres", statement+";"); err != nil {
			return providers.DbDatabaseInfo{}, err
		}
	} else {
		statement := "CREATE DATABASE " + quoteMySQL(p.Name)
		if p.Encoding != "" {
			if err := checkCharset(p.Encoding); err != nil {
				return providers.DbDatabaseInfo{}, err
			}
			statement += " CHARACTER SET " + p.Encoding
		}
		if p.Collation != "" {
			if err := checkCharset(p.Collation); err != nil {
				return providers.DbDatabaseInfo{}, err
			}
			statement += " COLLATE " + p.Collation
		}
		if _, err := o.mysql(ctx, "", statement+";"); err != nil {
			return providers.DbDatabaseInfo{}, err
		}
	}

	databases, err := o.ListDatabases(ctx, providers.DbEngineParams{Engine: p.Engine})
	if err != nil {
		return providers.DbDatabaseInfo{}, err
	}
	for _, database := range databases {
		if database.Name == p.Name {
			return database, nil
		}
	}
	return providers.DbDatabaseInfo{Name: p.Name, Encoding: p.Encoding}, nil
}

func (o databaseOps) DeleteDatabase(ctx context.Context, p providers.DbDatabaseDeleteParams) error {
	if _, system := systemSchemas[p.Name]; system {
		return fmt.Errorf("%s belongs to the engine and will not be dropped: %w", p.Name, providers.ErrPermissionDenied)
	}
	if isPostgres(p.Engine) {
		_, err := o.psql(ctx, "postgres", "DROP DATABASE IF EXISTS "+quotePG(p.Name)+";")
		return err
	}
	_, err := o.mysql(ctx, "", "DROP DATABASE IF EXISTS "+quoteMySQL(p.Name)+";")
	return err
}

/* -------------------------------- users ------------------------------ */

func (o databaseOps) ListUsers(ctx context.Context, p providers.DbEngineParams) ([]providers.DbUserInfo, error) {
	if isPostgres(p.Engine) {
		rows, err := o.psql(ctx, "postgres",
			"SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY rolname;")
		if err != nil {
			return nil, err
		}
		users := make([]providers.DbUserInfo, 0, len(rows))
		for _, row := range rows {
			if len(row) < 3 {
				continue
			}
			users = append(users, providers.DbUserInfo{
				Username:    row[0],
				HostPattern: "localhost",
				IsSuperuser: row[1] == "t",
				CanLogin:    row[2] == "t",
			})
		}
		return users, nil
	}

	rows, err := o.mysql(ctx, "", "SELECT User, Host, plugin, Super_priv, account_locked FROM mysql.user ORDER BY User, Host;")
	if err != nil {
		// Older MySQL has no account_locked column; ask again without it
		// rather than failing the whole page.
		rows, err = o.mysql(ctx, "", "SELECT User, Host, plugin, Super_priv FROM mysql.user ORDER BY User, Host;")
		if err != nil {
			return nil, err
		}
	}

	users := make([]providers.DbUserInfo, 0, len(rows))
	for _, row := range rows {
		if len(row) < 4 {
			continue
		}
		user := providers.DbUserInfo{
			Username:    row[0],
			HostPattern: row[1],
			IsSuperuser: strings.EqualFold(row[3], "Y"),
			CanLogin:    true,
		}
		if row[2] != "" && row[2] != "NULL" {
			user.AuthPlugin = stringPtr(row[2])
		}
		if len(row) > 4 && strings.EqualFold(row[4], "Y") {
			user.CanLogin = false
		}
		users = append(users, user)
	}
	return users, nil
}

func (o databaseOps) CreateUser(ctx context.Context, p providers.DbUserCreateParams) (providers.DbUserInfo, error) {
	if isPostgres(p.Engine) {
		statement := "CREATE ROLE " + quotePG(p.Username) + " LOGIN PASSWORD " + literal(p.Password) + ";"
		if _, err := o.psql(ctx, "postgres", statement); err != nil {
			return providers.DbUserInfo{}, err
		}
		return providers.DbUserInfo{Username: p.Username, HostPattern: "localhost", CanLogin: true}, nil
	}

	if err := checkHostPattern(p.HostPattern); err != nil {
		return providers.DbUserInfo{}, err
	}
	statement := fmt.Sprintf("CREATE USER %s@%s IDENTIFIED BY %s;",
		literal(p.Username), literal(p.HostPattern), literal(p.Password))
	if _, err := o.mysql(ctx, "", statement); err != nil {
		return providers.DbUserInfo{}, err
	}
	return providers.DbUserInfo{Username: p.Username, HostPattern: p.HostPattern, CanLogin: true}, nil
}

func (o databaseOps) UpdateUser(ctx context.Context, p providers.DbUserUpdateParams) (providers.DbUserInfo, error) {
	statements := make([]string, 0, 2)

	if isPostgres(p.Engine) {
		if p.Password != "" {
			statements = append(statements, "ALTER ROLE "+quotePG(p.Username)+" PASSWORD "+literal(p.Password)+";")
		}
		if p.CanLogin != nil {
			access := "NOLOGIN"
			if *p.CanLogin {
				access = "LOGIN"
			}
			statements = append(statements, "ALTER ROLE "+quotePG(p.Username)+" "+access+";")
		}
		if len(statements) > 0 {
			if _, err := o.psql(ctx, "postgres", strings.Join(statements, "\n")); err != nil {
				return providers.DbUserInfo{}, err
			}
		}
		return providers.DbUserInfo{
			Username:    p.Username,
			HostPattern: "localhost",
			CanLogin:    p.CanLogin == nil || *p.CanLogin,
		}, nil
	}

	if err := checkHostPattern(p.HostPattern); err != nil {
		return providers.DbUserInfo{}, err
	}
	account := literal(p.Username) + "@" + literal(p.HostPattern)
	if p.Password != "" {
		statements = append(statements, "ALTER USER "+account+" IDENTIFIED BY "+literal(p.Password)+";")
	}
	if p.CanLogin != nil {
		state := "ACCOUNT LOCK"
		if *p.CanLogin {
			state = "ACCOUNT UNLOCK"
		}
		statements = append(statements, "ALTER USER "+account+" "+state+";")
	}
	if len(statements) > 0 {
		if _, err := o.mysql(ctx, "", strings.Join(statements, "\n")); err != nil {
			return providers.DbUserInfo{}, err
		}
	}
	return providers.DbUserInfo{
		Username:    p.Username,
		HostPattern: p.HostPattern,
		CanLogin:    p.CanLogin == nil || *p.CanLogin,
	}, nil
}

func (o databaseOps) DeleteUser(ctx context.Context, p providers.DbUserDeleteParams) error {
	if isPostgres(p.Engine) {
		_, err := o.psql(ctx, "postgres", "DROP ROLE IF EXISTS "+quotePG(p.Username)+";")
		return err
	}
	if err := checkHostPattern(p.HostPattern); err != nil {
		return err
	}
	_, err := o.mysql(ctx, "", fmt.Sprintf("DROP USER IF EXISTS %s@%s;", literal(p.Username), literal(p.HostPattern)))
	return err
}

func (o databaseOps) ApplyGrant(ctx context.Context, p providers.DbGrantApplyParams) error {
	privileges, err := normalizePrivileges(p.Privileges)
	if err != nil {
		return err
	}

	if isPostgres(p.Engine) {
		database, user := quotePG(p.Database), quotePG(p.Username)
		// Revoking first is what makes this an "apply" rather than an
		// "add": the resulting grant set is exactly what was asked for.
		statements := []string{
			"REVOKE ALL PRIVILEGES ON DATABASE " + database + " FROM " + user + ";",
			"REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM " + user + ";",
			"REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM " + user + ";",
		}
		if _, err := o.psql(ctx, p.Database, strings.Join(statements, "\n")); err != nil {
			return err
		}
		if len(privileges) == 0 {
			return nil
		}

		grants := []string{"GRANT CONNECT, TEMPORARY ON DATABASE " + database + " TO " + user + ";"}
		if contains(privileges, "ALL") {
			grants = append(grants,
				"GRANT ALL PRIVILEGES ON DATABASE "+database+" TO "+user+";",
				"GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "+user+";",
				"GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "+user+";",
				"GRANT USAGE, CREATE ON SCHEMA public TO "+user+";",
			)
		} else {
			table := postgresTablePrivileges(privileges)
			if table != "" {
				grants = append(grants,
					"GRANT USAGE ON SCHEMA public TO "+user+";",
					"GRANT "+table+" ON ALL TABLES IN SCHEMA public TO "+user+";",
				)
			}
		}
		_, err := o.psql(ctx, p.Database, strings.Join(grants, "\n"))
		return err
	}

	if err := checkHostPattern(p.HostPattern); err != nil {
		return err
	}
	account := literal(p.Username) + "@" + literal(p.HostPattern)
	scope := quoteMySQL(p.Database) + ".*"

	// A user with no grants makes REVOKE an error, which is not a failure
	// of this call, so its result is deliberately not fatal.
	if _, err := o.mysql(ctx, "", "REVOKE ALL PRIVILEGES ON "+scope+" FROM "+account+";"); err != nil {
		o.p.log.Debug("nothing to revoke before applying grants", "user", p.Username, "database", p.Database)
	}
	if len(privileges) == 0 {
		_, err := o.mysql(ctx, "", "FLUSH PRIVILEGES;")
		return err
	}

	statement := "GRANT " + strings.Join(privileges, ", ") + " ON " + scope + " TO " + account + ";\nFLUSH PRIVILEGES;"
	_, err = o.mysql(ctx, "", statement)
	return err
}

/* -------------------------------- size ------------------------------- */

func (o databaseOps) Size(ctx context.Context, p providers.DbSizeParams) (providers.DbSizeResult, error) {
	if isPostgres(p.Engine) {
		rows, err := o.psql(ctx, "postgres", "SELECT pg_database_size("+literal(p.Name)+")::bigint;")
		if err != nil {
			return providers.DbSizeResult{}, err
		}
		if len(rows) == 0 {
			return providers.DbSizeResult{}, notFound("database %s", p.Name)
		}
		size, _ := strconv.ParseInt(first(rows[0]), 10, 64)
		return providers.DbSizeResult{SizeBytes: size, TableCount: o.postgresTableCount(ctx, p.Name)}, nil
	}

	rows, err := o.mysql(ctx, "", "SELECT COALESCE(SUM(DATA_LENGTH+INDEX_LENGTH),0), COUNT(*) "+
		"FROM information_schema.TABLES WHERE TABLE_SCHEMA = "+literal(p.Name)+";")
	if err != nil {
		return providers.DbSizeResult{}, err
	}
	if len(rows) == 0 || len(rows[0]) < 2 {
		return providers.DbSizeResult{}, notFound("database %s", p.Name)
	}
	size, _ := strconv.ParseInt(rows[0][0], 10, 64)
	tables, _ := strconv.Atoi(rows[0][1])
	return providers.DbSizeResult{SizeBytes: size, TableCount: tables}, nil
}

func (o databaseOps) postgresTableCount(ctx context.Context, database string) int {
	rows, err := o.psql(ctx, database,
		"SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema');")
	if err != nil || len(rows) == 0 {
		return 0
	}
	count, _ := strconv.Atoi(first(rows[0]))
	return count
}

/* --------------------------- dump and restore ------------------------ */

func (o databaseOps) Dump(ctx context.Context, p providers.DbDumpParams, stream providers.Stream) (providers.DbDumpResult, error) {
	options, err := o.dumpCommand(p)
	if err != nil {
		return providers.DbDumpResult{}, err
	}

	destination := p.Destination
	if p.Compress && !strings.HasSuffix(destination, ".gz") {
		destination += ".gz"
	}
	handle, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return providers.DbDumpResult{}, wrapFsError(destination, err)
	}
	defer handle.Close()

	counter := &progressWriter{ctx: ctx, stream: stream, target: handle, label: p.Name}
	var sink io.WriteCloser = nopCloser{counter}
	if p.Compress {
		sink = gzip.NewWriter(counter)
	}

	cmd, err := command(ctx, options)
	if err != nil {
		return providers.DbDumpResult{}, err
	}
	var stderr captureWriter
	stderr.limit = execOutputLimit
	cmd.Stdout = sink
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		sink.Close()
		os.Remove(destination)
		return providers.DbDumpResult{}, execError(options.Name, stderr.String(), err)
	}
	if err := sink.Close(); err != nil {
		return providers.DbDumpResult{}, fmt.Errorf("finish %s: %w", destination, err)
	}
	if err := handle.Sync(); err != nil {
		return providers.DbDumpResult{}, fmt.Errorf("sync %s: %w", destination, err)
	}

	info, err := handle.Stat()
	if err != nil {
		return providers.DbDumpResult{}, wrapFsError(destination, err)
	}
	return providers.DbDumpResult{Path: destination, SizeBytes: info.Size()}, nil
}

func (o databaseOps) Restore(ctx context.Context, p providers.DbRestoreParams, stream providers.Stream) error {
	handle, err := os.Open(p.Source)
	if err != nil {
		return wrapFsError(p.Source, err)
	}
	defer handle.Close()

	var source io.Reader = handle
	if strings.HasSuffix(p.Source, ".gz") {
		unzipped, err := gzip.NewReader(handle)
		if err != nil {
			return fmt.Errorf("open %s as gzip: %w", p.Source, err)
		}
		defer unzipped.Close()
		source = unzipped
	}

	if p.DropExisting {
		if err := o.DeleteDatabase(ctx, providers.DbDatabaseDeleteParams{Engine: p.Engine, Name: p.Name}); err != nil {
			return err
		}
		if _, err := o.CreateDatabase(ctx, providers.DbDatabaseCreateParams{Engine: p.Engine, Name: p.Name}); err != nil {
			return err
		}
	}

	options, err := o.restoreCommand(p)
	if err != nil {
		return err
	}
	cmd, err := command(ctx, options)
	if err != nil {
		return err
	}
	cmd.Stdin = source

	sink := &captureWriter{limit: execOutputLimit}
	cmd.Stdout = &streamWriter{ctx: ctx, stream: stream, sink: sink}
	cmd.Stderr = &streamWriter{ctx: ctx, stream: stream, sink: sink}

	if err := cmd.Run(); err != nil {
		return execError(options.Name, sink.String(), err)
	}
	return nil
}

func (o databaseOps) dumpCommand(p providers.DbDumpParams) (execOptions, error) {
	if isPostgres(p.Engine) {
		return execOptions{
			Name: "pg_dump",
			Args: []string{"--no-owner", "--no-privileges", "--format=plain", "--dbname=" + p.Name},
			User: postgresAccount(),
			Env:  cLocale(),
		}, nil
	}
	binary, ok := mysqlBinary("mysqldump")
	if !ok {
		return execOptions{}, unsupported("mysqldump is not installed")
	}
	return execOptions{
		Name: binary,
		Args: []string{"--single-transaction", "--quick", "--routines", "--triggers", "--databases", p.Name},
		Env:  cLocale(),
	}, nil
}

func (o databaseOps) restoreCommand(p providers.DbRestoreParams) (execOptions, error) {
	if isPostgres(p.Engine) {
		return execOptions{
			Name: "psql",
			Args: []string{"-X", "-q", "-v", "ON_ERROR_STOP=1", "--dbname=" + p.Name},
			User: postgresAccount(),
			Env:  cLocale(),
		}, nil
	}
	binary, ok := mysqlBinary("mysql")
	if !ok {
		return execOptions{}, unsupported("no mysql client is installed")
	}
	return execOptions{Name: binary, Args: []string{"--database=" + p.Name}, Env: cLocale()}, nil
}

/* ------------------------------- clients ----------------------------- */

// mysql runs a batch of statements with the SQL on stdin and returns the
// tab-separated rows. `database` selects a default schema when set.
func (o databaseOps) mysql(ctx context.Context, database, statements string) ([][]string, error) {
	binary, ok := mysqlBinary("mysql")
	if !ok {
		return nil, unsupported("no mysql client is installed")
	}

	args := []string{"--batch", "--raw", "--skip-column-names", "--connect-timeout=10"}
	if database != "" {
		args = append(args, "--database="+database)
	}
	out, err := runWith(ctx, execOptions{Name: binary, Args: args, Stdin: []byte(statements + "\n"), Env: cLocale()})
	if err != nil {
		return nil, err
	}

	rows := make([][]string, 0, 16)
	for _, line := range splitLines(out) {
		rows = append(rows, strings.Split(line, "\t"))
	}
	return rows, nil
}

// psql runs a batch as the cluster's own system account, which is how a
// peer-authenticated PostgreSQL is reached without a password and
// without a shell in between.
func (o databaseOps) psql(ctx context.Context, database, statements string) ([][]string, error) {
	args := []string{"-X", "-q", "-A", "-t", "-F", psqlSeparator, "-v", "ON_ERROR_STOP=1"}
	if database != "" {
		args = append(args, "--dbname="+database)
	}
	out, err := runWith(ctx, execOptions{
		Name:  "psql",
		Args:  args,
		Stdin: []byte(statements + "\n"),
		User:  postgresAccount(),
		Env:   cLocale(),
	})
	if err != nil {
		return nil, err
	}

	rows := make([][]string, 0, 16)
	for _, line := range splitLines(out) {
		if line == "" {
			continue
		}
		rows = append(rows, strings.Split(line, psqlSeparator))
	}
	return rows, nil
}

// postgresAccount is the system user the cluster trusts. If it is absent
// the agent stays root and lets the engine decide.
func postgresAccount() string {
	if _, err := user.Lookup("postgres"); err == nil {
		return "postgres"
	}
	return ""
}

// mysqlBinary prefers the MariaDB-named tools when the MySQL-named ones
// are gone, which is the case on recent MariaDB packages.
func mysqlBinary(name string) (string, bool) {
	alternatives := map[string]string{"mysql": "mariadb", "mysqldump": "mariadb-dump"}
	if _, err := exec.LookPath(name); err == nil {
		return name, true
	}
	if alternative, ok := alternatives[name]; ok {
		if _, err := exec.LookPath(alternative); err == nil {
			return alternative, true
		}
	}
	return "", false
}

/* ------------------------------- progress ---------------------------- */

// progressWriter reports how far a dump has got without buffering it, so
// an operator watching a 40 GB dump sees something move.
type progressWriter struct {
	ctx    context.Context
	stream providers.Stream
	target io.Writer
	label  string

	written  int64
	reported int64
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n, err := w.target.Write(p)
	w.written += int64(n)

	if w.stream != nil && w.written-w.reported >= dumpProgressStride {
		w.reported = w.written
		line := fmt.Sprintf("%s: %d bytes written\n", w.label, w.written)
		if sendErr := w.stream.Send(w.ctx, []byte(line), providers.EncodingUTF8); sendErr != nil {
			return n, sendErr
		}
	}
	return n, err
}

type nopCloser struct{ io.Writer }

func (nopCloser) Close() error { return nil }

/* ------------------------------ validation --------------------------- */

func isPostgres(engine string) bool { return engine == "postgres" }

// quoteMySQL and quotePG double the engine's own quote character, which
// is the only escape either dialect defines for an identifier.
func quoteMySQL(identifier string) string {
	return "`" + strings.ReplaceAll(identifier, "`", "``") + "`"
}

func quotePG(identifier string) string {
	return `"` + strings.ReplaceAll(identifier, `"`, `""`) + `"`
}

// literal quotes a value. Backslashes are escaped as well as quotes,
// because MySQL treats a backslash as an escape character by default
// while PostgreSQL, under standard_conforming_strings, does not — and
// doubling a backslash is safe in both.
func literal(value string) string {
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, "'", "''")
	return "'" + escaped + "'"
}

func checkHostPattern(pattern string) error {
	if pattern == "" || len(pattern) > 64 {
		return invalid("host_pattern must be between 1 and 64 characters")
	}
	for i := 0; i < len(pattern); i++ {
		c := pattern[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '.', c == '-', c == '_', c == '%', c == ':':
		default:
			return invalid("host_pattern contains an illegal character")
		}
	}
	return nil
}

func checkCharset(value string) error {
	if value == "" || len(value) > 64 {
		return invalid("character set must be between 1 and 64 characters")
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '_', c == '-', c == '.':
		default:
			return invalid("character set contains an illegal character")
		}
	}
	return nil
}

// normalizePrivileges upper-cases and re-checks the privilege list. The
// values are concatenated into a GRANT, so an unrecognised one is
// rejected rather than passed through.
func normalizePrivileges(privileges []string) ([]string, error) {
	allowed := map[string]struct{}{
		"SELECT": {}, "INSERT": {}, "UPDATE": {}, "DELETE": {}, "CREATE": {},
		"DROP": {}, "ALTER": {}, "INDEX": {}, "REFERENCES": {}, "TRIGGER": {},
		"EXECUTE": {}, "TEMPORARY": {}, "ALL": {},
	}

	out := make([]string, 0, len(privileges))
	for _, privilege := range privileges {
		upper := strings.ToUpper(strings.TrimSpace(privilege))
		if _, ok := allowed[upper]; !ok {
			return nil, invalid("%q is not a grantable privilege", privilege)
		}
		out = append(out, upper)
	}
	return out, nil
}

// postgresTablePrivileges keeps only the verbs PostgreSQL accepts on a
// table; MySQL's schema-level extras have no equivalent there.
func postgresTablePrivileges(privileges []string) string {
	allowed := map[string]struct{}{
		"SELECT": {}, "INSERT": {}, "UPDATE": {}, "DELETE": {}, "TRIGGER": {}, "REFERENCES": {},
	}
	kept := make([]string, 0, len(privileges))
	for _, privilege := range privileges {
		if _, ok := allowed[privilege]; ok {
			kept = append(kept, privilege)
		}
	}
	return strings.Join(kept, ", ")
}

func contains(items []string, needle string) bool {
	for _, item := range items {
		if item == needle {
			return true
		}
	}
	return false
}

func first(row []string) string {
	if len(row) == 0 {
		return ""
	}
	return row[0]
}
