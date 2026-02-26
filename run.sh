rm -rf dist
npm run build
pm2 restart krishna-contest
pm2 logs krishna-contest --lines 50

# Fix static permissions for nginx after build
chmod o+rx /home/ubuntu
chmod o+rx /home/ubuntu/apps
chmod o+rx /home/ubuntu/apps/krishna-contest-v1
chmod o+rx /home/ubuntu/apps/krishna-contest-v1/dist
chmod o+rx /home/ubuntu/apps/krishna-contest-v1/dist/public
chmod o+rx /home/ubuntu/apps/krishna-contest-v1/dist/public/images
chmod o+r  /home/ubuntu/apps/krishna-contest-v1/dist/public/images/*

sudo cp -a dist/public/images/. /var/www/krishna/images/
sudo chown -R www-data:www-data /var/www/krishna
sudo chmod -R 755 /var/www/krishna
