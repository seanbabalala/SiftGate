import * as fs from 'fs';
import * as path from 'path';

describe('release version sync', () => {
  it('keeps OSS release versions aligned across root, TypeScript client, and Python package', () => {
    const rootPackage = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    const clientPackage = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '..', '..', 'packages', 'client', 'package.json'),
        'utf8',
      ),
    ) as { version: string };
    const pythonPyproject = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'packages', 'python', 'pyproject.toml'),
      'utf8',
    );
    const pythonVersion = pythonPyproject.match(/^version = "([^"]+)"$/m)?.[1];

    expect(rootPackage.version).toBe('2.12.0');
    expect(clientPackage.version).toBe(rootPackage.version);
    expect(pythonVersion).toBe(rootPackage.version);
  });
});
