ALTER TABLE `profile` ADD FOREIGN KEY (`gender`) REFERENCES `gender` (`code`) ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE `profile` ADD FOREIGN KEY (`owner`) REFERENCES `user` (`id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

