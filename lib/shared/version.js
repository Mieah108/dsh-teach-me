/**
 * 单一版本源：package.json。运行期只读这一个文件，不生成第二份版本常量。
 */
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

export const PACKAGE_NAME = packageJson.name;
export const PACKAGE_VERSION = packageJson.version;
