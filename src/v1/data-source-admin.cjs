const path = require('node:path');
const {
  createConfiguredSQLiteDataSource,
  readDataSourceManifest
} = require('./data-source-config.cjs');
const {
  createConfiguredNetworkDataSource,
  readNetworkDataSourceManifest
} = require('./network-data-source-config.cjs');

const PROFILE_FILES = Object.freeze([
  Object.freeze({ engine: 'sqlite', fileName: 'legal-cases.sqlite.json' }),
  Object.freeze({ engine: 'postgresql', fileName: 'legal-cases.postgresql.json' }),
  Object.freeze({ engine: 'mysql', fileName: 'legal-cases.mysql.json' })
]);

class DataSourceAdminError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DataSourceAdminError';
    this.code = code;
  }
}

function isConfigured(environment, name) {
  return typeof environment[name] === 'string' && environment[name].trim().length > 0;
}

function freezeProfile(profile) {
  return Object.freeze({
    ...profile,
    environment: Object.freeze(profile.environment.map((item) => Object.freeze({ ...item }))),
    missingEnvironmentNames: Object.freeze([...profile.missingEnvironmentNames]),
    allowedTables: Object.freeze([...profile.allowedTables]),
    allowedColumns: Object.freeze([...profile.allowedColumns]),
    limits: Object.freeze({ ...profile.limits })
  });
}

function createDataSourceAdmin(options = {}) {
  const projectRoot = path.resolve(options.projectRoot ?? path.join(__dirname, '..', '..'));
  const environment = options.env ?? process.env;
  const manifestDirectory = path.resolve(
    options.manifestDirectory ?? path.join(projectRoot, 'configs', 'data-sources')
  );
  const configuredRuntime = environment.LEGAL_V1_RUNTIME?.trim() || 'demo';
  const activeRuntime = ['demo', 'sqlite', 'postgresql', 'mysql'].includes(configuredRuntime)
    ? configuredRuntime
    : 'invalid';

  function loadProfiles() {
    return PROFILE_FILES.map(({ engine, fileName }) => {
      const manifestPath = path.join(manifestDirectory, fileName);
      const manifest =
        engine === 'sqlite'
          ? readDataSourceManifest(manifestPath)
          : readNetworkDataSourceManifest(manifestPath);
      const requiredEnvironmentNames =
        engine === 'sqlite'
          ? [manifest.databasePathEnv]
          : ['host', 'port', 'database', 'user', 'password'].map(
              (key) => manifest.connectionEnv[key]
            );
      const optionalEnvironmentNames =
        engine === 'sqlite' ? [] : [manifest.connectionEnv.tlsMode];
      const environmentStatus = [
        ...requiredEnvironmentNames.map((name) => ({
          name,
          required: true,
          configured: isConfigured(environment, name)
        })),
        ...optionalEnvironmentNames.map((name) => ({
          name,
          required: false,
          configured: isConfigured(environment, name)
        }))
      ];
      const missingEnvironmentNames = environmentStatus
        .filter((item) => item.required && !item.configured)
        .map((item) => item.name);
      return {
        manifest,
        manifestPath,
        public: freezeProfile({
          profileId: manifest.id,
          schemaVersion: manifest.schemaVersion,
          engine: manifest.engine,
          accessMode: manifest.accessMode,
          active: activeRuntime === manifest.engine,
          manifestStatus: 'valid',
          configurationStatus:
            missingEnvironmentNames.length === 0 ? 'ready' : 'missing_environment',
          environment: environmentStatus,
          missingEnvironmentNames,
          allowedTables: manifest.allowedTables,
          allowedColumns: manifest.allowedColumns,
          limits: {
            timeoutMs: manifest.timeoutMs,
            maxRows: manifest.maxRows,
            maxOutputBytes: manifest.maxOutputBytes
          },
          credentialValuesExposed: false
        })
      };
    });
  }

  async function defaultSourceFactory(profile) {
    if (profile.manifest.engine === 'sqlite') {
      return createConfiguredSQLiteDataSource({
        projectRoot,
        manifestPath: profile.manifestPath,
        env: environment
      });
    }
    return createConfiguredNetworkDataSource({
      manifestPath: profile.manifestPath,
      env: environment
    });
  }

  const sourceFactory = options.sourceFactory ?? defaultSourceFactory;

  return Object.freeze({
    listProfiles() {
      return Object.freeze({
        status: 'ok',
        activeRuntime,
        credentialInputAccepted: false,
        credentialValuesExposed: false,
        profiles: Object.freeze(loadProfiles().map((profile) => profile.public))
      });
    },

    async validateProfile(profileId) {
      if (typeof profileId !== 'string' || profileId.length === 0) {
        throw new DataSourceAdminError('PROFILE_ID_INVALID', 'profileId must be a non-empty string.');
      }
      const profile = loadProfiles().find((candidate) => candidate.public.profileId === profileId);
      if (!profile) {
        throw new DataSourceAdminError('DATA_SOURCE_PROFILE_NOT_FOUND', 'Data-source profile was not found.');
      }
      if (profile.public.configurationStatus !== 'ready') {
        return Object.freeze({
          status: 'not_configured',
          profileId,
          engine: profile.public.engine,
          connectionAttempted: false,
          missingEnvironmentNames: profile.public.missingEnvironmentNames,
          credentialValuesExposed: false
        });
      }

      let source;
      try {
        source = await sourceFactory(profile);
        const connection = await source.testConnection();
        if (connection?.status !== 'connected') {
          return Object.freeze({
            status: 'failed',
            profileId,
            engine: profile.public.engine,
            connectionAttempted: true,
            connectionStatus: 'failed',
            errorCode: 'DATA_SOURCE_VALIDATION_FAILED',
            credentialValuesExposed: false
          });
        }
        const snapshot = await source.inspectSchema();
        const schema = snapshot?.schema;
        const columnNames = Array.isArray(schema?.columns)
          ? schema.columns.map((column) => column?.name)
          : [];
        if (
          typeof snapshot?.schemaFingerprint !== 'string' ||
          !/^[0-9a-f]{64}$/.test(snapshot.schemaFingerprint) ||
          typeof schema?.tableName !== 'string' ||
          !profile.public.allowedTables.includes(schema.tableName) ||
          columnNames.length === 0 ||
          columnNames.some(
            (name) => typeof name !== 'string' || !profile.public.allowedColumns.includes(name)
          )
        ) {
          throw new Error('Invalid allowlisted Schema receipt.');
        }
        return Object.freeze({
          status: 'verified',
          profileId,
          engine: profile.public.engine,
          connectionAttempted: true,
          connectionStatus: 'connected',
          schemaStatus: 'verified',
          schemaFingerprint: snapshot.schemaFingerprint,
          tableCount: 1,
          columnCount: columnNames.length,
          readOnly: profile.public.accessMode === 'read-only',
          credentialValuesExposed: false
        });
      } catch {
        return Object.freeze({
          status: 'failed',
          profileId,
          engine: profile.public.engine,
          connectionAttempted: true,
          connectionStatus: 'failed',
          errorCode: 'DATA_SOURCE_VALIDATION_FAILED',
          credentialValuesExposed: false
        });
      } finally {
        try {
          await source?.close?.();
        } catch {
          // Validation responses never expose Provider close errors or connection details.
        }
      }
    }
  });
}

module.exports = {
  DataSourceAdminError,
  PROFILE_FILES,
  createDataSourceAdmin
};
