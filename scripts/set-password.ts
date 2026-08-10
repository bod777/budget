/**
 * Prints the bcrypt hash to put in APP_PASSWORD_HASH.
 *
 *   npm run set-password -- 'the password'
 *
 * The password itself is never stored anywhere -- only the hash goes into the
 * environment, so losing it means setting a new one rather than recovering it.
 */
import bcrypt from 'bcryptjs';

const password = process.argv[2];
if (!password) {
  console.error("usage: npm run set-password -- 'your password'");
  process.exit(1);
}
if (password.length < 10) {
  console.error('use at least 10 characters — this guards your entire financial history');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
console.log('\nAdd this to your environment:\n');
console.log(`APP_PASSWORD_HASH=${hash}\n`);
