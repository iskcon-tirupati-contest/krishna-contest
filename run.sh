rm -rf dist
npm run build
pm2 restart krishna-contest
pm2 logs krishna-contest --lines 50

