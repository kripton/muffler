#!/bin/bash

ln -s /etc/init.d/net.lo /etc/init.d/net.eth0
ln -s /etc/init.d/net.lo /etc/init.d/net.wlan0
ln -s /etc/init.d/net.lo /etc/init.d/net.br0
rc-update add net.eth0 default
rc-update add net.wlan0 default
rc-update add net.br0 default