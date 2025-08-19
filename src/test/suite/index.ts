/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import * as path from 'path';
import * as Mocha from 'mocha';
import { glob } from 'glob';

export async function run(): Promise<void> {
    // Create the mocha test
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    const testsRoot = path.resolve(__dirname, '..');

    try {
        const files: string[] = await glob('**/**.test.js', { cwd: testsRoot });
        files.forEach((f: string) => mocha.addFile(path.resolve(testsRoot, f)));
    } catch (err) {
        return Promise.reject(err as Error);
    }

    return new Promise((c, e) => {
        try {
            // Run the mocha test
            mocha.run(failures => {
                if (failures > 0) {
                    e(new Error(`${failures} tests failed.`));
                } else {
                    c();
                }
            });
        } catch (err) {
            e(err as Error);
        }
    });
}