/*
 if you're reading this source please not that "NodeBB" == "nbb" ==  "Nbb" == "NBB" as a terminology
 and ubb means the UBB Threads Forum Software, here's a link => http://www.ubbcentral.com/

 This Converter is written and tested for UBB 7.5.7 which was released sometime in 2013,
 */

// todo maybe go through all users who has user.customPicture == true, and test each image url if 200 or not and filter the ones pointing to my old forum avatar dir
// todo nothing is really skippable at the moment, the nodebb db needs to be flushed, run node app.js --setup, then node app.js --upgrade
// todo generate my nginx rewrite rules from the nbb map files
// todo still, make sure the [YOUR_UBB_PATH]/images/avatars/* is still normally accessible to keep the old avatars
// todo clear the default categories in nodebb/install so I would start with fresh categories.

// todo send emails to all users with temp passwords
// todo if I have time, maybe implement a nbb plugin that enforces the 1 time use of temp passwords.
// todo TEST yo


"use strict";


var Group, Meta, User, Topics, Posts, Categories, RDB;

// todo: the plugins page says to use this 'var User = module.parent.require('./user');' but that's not
try {
    Group = module.parent.require('./groups.js');
    Meta = module.parent.require('./meta.js');
    User = module.parent.require('./user.js');
    Topics = module.parent.require('./topics.js');
    Posts = module.parent.require('./posts.js');
    Categories = module.parent.require('./categories.js');
    RDB = module.parent.require('./redis.js');
} catch (e) {
    console.log("HA! ");
    Group = require('../../src/groups.js');
    Meta = require('../../src/meta.js');
    User = require('../../src/user.js');
    Topics = require('../../src/topics.js');
    Posts = require('../../src/posts.js');
    Categories = require('../../src/categories.js');
    RDB = require('../../src/redis.js');
}


var

// nbb Objects, required, these paths assume that the plugin lives in /NodeBB/node_modules/nodebb-plugin-ubbmigrator
// todo: the plugins page says to use this 'var User = module.parent.require('./user');' but that's working for some reason
//    User = module.parent.require('./user.js'),
//    Topics = module.parent.require('./topics.js'),
//    Posts = module.parent.require('./posts.js'),
//    Categories = module.parent.require('./categories.js'),

// nbb utils, very useful
    utils = require('../../public/src/utils.js'),

// some useful modules

// mysql to talk to ubb db
    mysql = require("mysql"),

// exactly what it means, ubb uses html for some posts, nbb uses markdown, right?
    htmlToMarkdown = require("html-md"),

// I'm lazy
    $ = require("jquery"),
    async = require("async"),
    fs = require("fs.extra"),
    http = require("http"),

// my quick logger
    Logger = require("./logger.js"),
//later to be initialized with config in init()
    logger,

    nbbData = {
        groups: {
            Administrators: {},
            Moderators: {}
        }
    };

module.exports = {

    migrate: function(config){
        var self = this;
        async.series([
            function(next){
                self.init(config, next);
            },
            function(next){
                logger.debug("setup()");
                self.initialSetup(next);
            },
            function(next){
                logger.debug("backupNbbConfigs()");
                self.backupNbbConfigs(next);
            },
            function(next){
                logger.debug("tempSetNbbConfigs()");
                self.tempSetNbbConfigs(next);
            },
            function(next){
                logger.debug("emptyNbbDefaultCategories()");
                self.emptyNbbDefaultCategories(next);
            },
            function(next){
                logger.debug("setupNbbGroups()");
                self.setupNbbGroups(next);
            },
            function (next) {
                if (self.config.dontGetFromUbb) {
                    logger.debug("Skipping ubbGetUsers()");
                    next();
                } else{
                    logger.debug("ubbGetUsers()");
                    self.ubbGetUsers(next);
                }
            },
            function (next) {
                if (self.config.dontGetFromUbb) {
                    logger.debug("Skipping ubbGetCategories()");
                    next();
                } else{
                    logger.debug("ubbGetCategories()");
                    self.ubbGetCategories(next);
                }
            },
            function (next) {
                if (self.config.dontGetFromUbb) {
                    logger.debug("Skipping ubbGetForums()");
                    next();
                } else{
                    logger.debug("ubbGetForums()");
                    self.ubbGetForums(next);
                }
            },
            function (next) {
                if (self.config.dontGetFromUbb) {
                    logger.debug("Skipping ubbGetTopics()");
                    next();
                } else{
                    logger.debug("ubbGetTopics()");
                    self.ubbGetTopics(next);
                }
            },
            function (next) {
                if (self.config.dontGetFromUbb) {
                    logger.debug("Skipping ubbGetPosts()");
                    next();
                } else{
                    logger.debug("ubbGetPosts()");
                    self.ubbGetPosts(next);
                }
            },
            function(next) {
                if (self.config.dontSaveToNbb) {
                    logger.debug("Skipping nbbSaveUsers()");
                    next();
                } else {
                    logger.debug("nbbSaveUsers()");
                    self.nbbSaveUsers(next);
                }
            },
            function(next) {
                // ubb.forums ===> nbb.categories
                if (self.config.dontSaveToNbb) {
                    logger.debug("Skipping nbbSaveCategories()");
                    next();
                } else {
                    logger.debug("nbbSaveCategories()");
                    self.nbbSaveCategories(next);
                }
            },
            function(next) {
                if (self.config.dontSaveToNbb) {
                    logger.debug("Skipping nbbSaveTopics()");
                    next();
                } else {
                    logger.debug("nbbSaveTopics()");
                    self.nbbSaveTopics(next);
                }
            },
            function(next) {
                if (self.config.dontSaveToNbb) {
                    logger.debug("Skipping nbbSavePosts()");
                    next();
                } else {
                    logger.debug("nbbSavePosts()");
                    self.nbbSavePosts(next);
                }
            },
            function(next) {
                self.restoreNbbConfigs(next);
            },
            function(){
                self.exit();
            }
        ]);
    },

    init: function(config, next){
        config = config || {};

        this.config = $.extend({}, {

            log: "error",

            ubbDbConfig: null,
            ubbTablePrefix: "ubbt_",

            // these NEED to start with ./whatever.json NOT whatever.json since I'm using require() to load them. I know, don't judge me pls.
            ubbTmpFiles: {
                users: "./tmp/ubb/users.json",
                categories: "./tmp/ubb/categories.json",
                forums: "./tmp/ubb/forums.json",
                topics: "./tmp/ubb/topics.json",
                posts: "./tmp/ubb/posts.json"
            },
            nbbTmpFiles: {
                users: "./tmp/nbb/users.json",
                // forums become categories in NBB, and I loose UBB categories
                categories: "./tmp/nbb/categories.json",
                topics: "./tmp/nbb/topics.json",
                posts: "./tmp/nbb/posts.json"
            },
            ubbToNbbMapFile: "./tmp/ubbToNbbMap.json",

            ubbqTestLimitToBeforeTimestampSeconds: {
                users: null,
                categories: null,
                forums: null,
                topics: null,
                posts: null
            },

            // meaning this will reuse the ubb tmp files
            dontGetFromUbb: false,
            // meaning this won't insert into nbb db
            dontSaveToNbb: false,

            passwordGen: {
                chars: "!@#$?)({}*.^qwertyuiopasdfghjklzxcvbnmQWERTYUIOPASDFGHJKLZXCVBNM1234567890",
                len: 13
            },

            // to be randomly selected from migrating the ubb.forums
            nbbCategoriesColorClasses: ["category-darkblue", "category-blue", "category-purple"],
            nbbCategoriesIcons: ["icon-comment"],

            nbbAutoConfirmEmails: true,

            // will create a nbb group for the ubb migrated moderators
            ubbToNbbModeratorsGroupName : "GoldModerators",
            ubbToNbbModeratorsGroupDescription: "Old timers forums moderators",
            // per nbb default setup, 1000+ reputation makes you a moderator
            ubbToNbbModeratorsAddedReputation: 1000,

            nginx: {
                // ONLY replace the MY_UBB_PATH and MY_NBB_PATH and leave the ${FROM} and ${TO} as they will be replaced appropriately
                // or i guess if you know what you're doing then modify at will
                // example: rewrite ^/MY_UBB_PATH/users/123(.*)$ /MY_NBB_PATH/user/elvis/$1 last;
                rule: " rewrite ^/MY_UBB_PATH/${FROM}(.*)$ /MY_NBB_PATH/${TO}$1 permanent;"
            }

        }, config);

        logger = Logger.init(this.config.log);
        logger.debug("init()");

        if (typeof next == "function")
            next();
    },

    initialSetup: function(next){
        var self = this;

        // create a map from ubb ids to new nbb data
        // useful for saving clear temp passwords for users
        // and creating ReWriteRules
        this.ubbToNbbMap = {
            users: {},
            categories: {},
            topics: {},
            posts: {},
            skippedUsers: {}
        };

        // in memory ubbData lists
        this.ubbData = {
            users: [],
            usersProfiles: [],
            categories: [],
            forums: [],
            topics: [],
            posts: []
        };

        if (!this.config.ubbDbConfig) throw new Error("config.ubbDbConfig needs to be passed in to migrate()");

        // mysql connection to ubb database
        this.ubbConnection = mysql.createConnection(this.config.ubbDbConfig);
        this.ubbConnection.connect();

        if (!this.config.dontGetFromUbb)
            Object.keys(this.config.ubbTmpFiles).forEach(function(key){
                fs.createFileSync(self.config.ubbTmpFiles[key]);
            });

        Object.keys(this.config.nbbTmpFiles).forEach(function(key){
            fs.createFileSync(self.config.nbbTmpFiles[key]);
        });

        fs.createFileSync(this.config.ubbToNbbMapFile);

        next();
    },


    emptyNbbDefaultCategories: function(next){

        // deleting the first 12 default categories by nbb
        RDB.keys("category:*", function(err, arr) {
            arr.forEach(function(k){
                RDB.del(k);
            });
            RDB.del("categories:cid", function(){
                next();
            });
        });
    },

    setupNbbGroups: function(next){
        var self = this;
        Group.getGidFromName("Administrators", function(err, gid) {
            // save a reference for the admins gid
            nbbData.groups.Administrators.gid = gid;
            // create an moderators group from the users who are ubb Moderators
            Group.create(self.config.ubbToNbbModeratorsGroupName, self.config.ubbToNbbModeratorsGroupDescription, function(err, group) {
                if (err) {
                    if (err.message == "group-exists") {
                        Group.getGidFromName(self.config.ubbToNbbModeratorsGroupName, function(err, gid){
                            // save a reference to the gid to use it when needed, bro
                            nbbData.groups.Moderators.gid = gid;
                            next();
                        });
                    }
                } else {
                    // save a reference to the gid to use it when needed, bro
                    nbbData.groups.Moderators.gid = group.gid;
                    next();
                }
            });

        });
    },

    backupNbbConfigs: function(next){
        var self = this;
        RDB.hgetall("config", function(err, data){
            self.config.nbbConfigs = data || {};
            next();
        });
    },

    tempSetNbbConfigs: function(next){
        var nbbTempConfigs = this.config.nbbConfigs;

        // yea.. i dont know .. i have a bad feeling about this
        nbbTempConfigs.postDelay = 0;
        nbbTempConfigs.minimumPostLength = 1;
        nbbTempConfigs.minimumTitleLength = 1;
        nbbTempConfigs.maximumUsernameLength = 50;
        nbbTempConfigs.maximumProfileImageSize = 1024;

        // if you want to auto confirm email, set the host to null, if there is any
        // this will prevent User.sendConfirmationEmail from setting expiration time on the email address
        // per https://github.com/designcreateplay/NodeBB/blob/master/src/user.js#L458
        if (this.config.nbbAutoConfirmEmails)
            nbbTempConfigs['email:smtp:host'] = "this.host.is.set.by.ubbmigrator.todisable.email.confirmation";

        RDB.hmset("config", nbbTempConfigs, function(){
            next();
        });
    },

    restoreNbbConfigs: function(next){
        RDB.hmset("config", this.config.nbbConfigs, function(){
            next();
        });
    },

    // get ubb users
    ubbGetUsers: function(next) {
        var self = this, prefix = self.config.ubbTablePrefix;
        this.ubbq(
            "SELECT "
                + prefix + "USERS.USER_ID as _ouid, "
                + prefix + "USERS.USER_LOGIN_NAME as _username, "
                + prefix + "USERS.USER_DISPLAY_NAME as _userDisplayName, "
                + prefix + "USERS.USER_REGISTRATION_EMAIL as _email, "
                + prefix + "USERS.USER_MEMBERSHIP_LEVEL as _level, "
                + prefix + "USERS.USER_REGISTERED_ON as _joindate, "
                + prefix + "USERS.USER_IS_APPROVED as _approved, "
                + prefix + "USERS.USER_IS_banned as _banned, "

                + prefix + "USER_PROFILE.USER_SIGNATURE as _signature, "
                + prefix + "USER_PROFILE.USER_HOMEPAGE as _website, "
                + prefix + "USER_PROFILE.USER_OCCUPATION as _occupation, "
                + prefix + "USER_PROFILE.USER_LOCATION as _location, "
                + prefix + "USER_PROFILE.USER_AVATAR as _avatar, "
                + prefix + "USER_PROFILE.USER_TITLE as _title, "
                + prefix + "USER_PROFILE.USER_POSTS_PER_TOPIC as _postsPerTopic, "
                + prefix + "USER_PROFILE.USER_TEMPORARY_PASSWORD as _tempPassword, "
                + prefix + "USER_PROFILE.USER_TOTAL_POSTS as _totalPosts, "
                + prefix + "USER_PROFILE.USER_RATING as _rating, "
                + prefix + "USER_PROFILE.USER_TOTAL_RATES as _totalRates, "
                + prefix + "USER_PROFILE.USER_BIRTHDAY as _birthday, "
                + prefix + "USER_PROFILE.USER_UNVERIFIED_EMAIL as _unverifiedEmail "

                + "FROM " + prefix + "USERS, " + prefix + "USER_PROFILE "
                + "WHERE " + prefix + "USERS.USER_ID = " + prefix + "USER_PROFILE.USER_ID "
                + (self.config.ubbqTestLimitToBeforeTimestampSeconds.users ?
                "AND " + prefix + "USERS.USER_REGISTERED_ON < " + self.config.ubbqTestLimitToBeforeTimestampSeconds.users : ""),

            function(err, rows){
                self.ubbData.users = self._convertListToMap(rows, "_ouid");
                self._ubbNormalizeUsers(self.ubbData.users);
                self._ubbMarkdownUsersSignatures();
                next();
            });
    },

    _makeValidNbbUsername: function(_username, _userDisplayName, _ouid) {
        var self = this
            , validUsername = false
            , username = _username ? self.cleanUsername(_username.toLowerCase()) : ""
            , userslug = utils.slugify(username || "");

        // if it's invalid by NodeBB's rules, i'll give the ubb.userDisplayName a try before I give up on that user account
        if (!utils.isUserNameValid(username) || !userslug) {

            logger.warn("[" + _ouid + "] " + "username: " + _username + " invalid... trying the user's display name...");
            username = _userDisplayName ? self.cleanUsername(_userDisplayName) : "";
            userslug = utils.slugify(username || "");

            if (!utils.isUserNameValid(username) || !userslug) {
                logger.warn("username: " + username + " still invalid, skipping ...");
            } else {
                validUsername = true;
            }

        } else {
            validUsername = true;
        }

        return {username: username, userslug: userslug,  validUsername: validUsername, _username: _username, _userDisplayName: _userDisplayName};
    },

    _ubbNormalizeUsers: function(users) {
        var self = this, first = true;
        var arr = Object.keys(users);

        fs.writeFileSync(self.config.ubbTmpFiles.users, "");

        arr.forEach(function(_ouid, ui){
            var user = users[_ouid];
            if (user._username && user._joindate && user._email) {

                user = $.extend({}, user, self._makeValidNbbUsername(user._username, user._userDisplayName, user._ouid));
                if (user.validUsername) {

                    // nbb forces signatures to be less than 150 chars
                    user.signature = self.truncateStr(user._signature || "", 150);

                    // from unix timestamp (s) to JS timestamp (ms)
                    user._joindate = user._joindate * 1000;

                    // lower case the email as well
                    user.email = user._email.toLowerCase();

                    // I don't know about you about I noticed a lot my users have incomplete urls
                    //user.avatar = self._isValidUrl(user._avatar) ? user._avatar : "";
                    //user.website = self._isValidUrl(user._website) ? user._website : "";
                    // this is a little faster, and less agressive
                    user.avatar = self._isValidUrlSimple(user._avatar) ? user._avatar : "";
                    user.website = self._isValidUrlSimple(user._website) ? user._website : "";

                    // generate a temp password, don't worry i'll add the clear text to the map so you can email it to the user
                    user.password = self._genRandPwd(self.config.passwordGen.len, self.config.passwordGen.chars);

                    //users[_ouid] = user;

                    fs.appendFileSync(self.config.ubbTmpFiles.users, (first ? "[" : ",\n") + JSON.stringify(user, null, 4));

                    if (first)
                        first = false;

                    if (ui % 1000 == 0)
                        logger.info(" saved " + ui + " users so far.");

                } else {
                    logger.warn("[!username] skipping user " + user._username + ":" + user._email + " _ouid: " + _ouid);
                    delete users[_ouid];
                }
            } else {
                logger.warn("[!_username | !_joindate | !_email] skipping user " + user._username + ":" + user._email + " _ouid: " + _ouid);
                delete users[_ouid];
            }
        });
        fs.appendFileSync(self.config.ubbTmpFiles.users, "]");

        logger.info("filtering " + arr.length + " users done");
        return users;
    },

    _ubbMarkdownUsersSignatures: function() {
        var self = this, first = true;
        var users = require(self.config.ubbTmpFiles.users);
        var arr = Object.keys(users);

        // empty dat file
        fs.writeFileSync(self.config.ubbTmpFiles.users, "");

        arr.forEach(function(_ouid, ui){
            var user = users[_ouid];
            user.signatureMd = self.hazHtml(user.signature) ? htmlToMarkdown(user.signature) : user.signature;
            fs.appendFileSync(self.config.ubbTmpFiles.users, (first ? "[" : ",\n") +  JSON.stringify(user, null, 4));

            if (first)
                first = false;

            if (ui % 1000 == 0)
                logger.info("'Markdowning' signatures processed " + ui + " users so far.");
        });
        fs.appendFileSync(self.config.ubbTmpFiles.users, "]");
        logger.debug("Markdowning " + arr.length + " users done");
        return users;
    },

    // get ubb categories
    // I don't actually use these?
    // since the ubb.forums become the nbb.categories
    // if you want them .. use them.
    ubbGetCategories: function(next) {
        var self = this;
        this.ubbq(
            "SELECT CATEGORY_ID as _ocid, CATEGORY_TITLE as _name, CATEGORY_DESCRIPTION as _description "
                + "FROM " + self.config.ubbTablePrefix + "CATEGORIES ",
            function(err, rows){
                logger.info("Categories query came back with " + rows.length + " records, now writing to tmp dir, please be patient.");
                if (err) throw err;
                self.ubbData.categories = self._convertListToMap(rows, "_ocid");

                self.saveMap(self.config.ubbTmpFiles.categories, self.ubbData.categories, rows.length, "UBB Categories", next);

            });
    },

    // get ubb forums
    ubbGetForums: function(next) {
        var self = this;
        this.ubbq(
            "SELECT FORUM_ID as _ofid, FORUM_TITLE as _name, FORUM_DESCRIPTION as _description, "
                + "CATEGORY_ID as _categoryId, FORUM_CREATED_ON as _datetime "
                + "FROM " + self.config.ubbTablePrefix + "FORUMS "
                + (self.config.ubbqTestLimitToBeforeTimestampSeconds.forums ?
                "WHERE FORUM_CREATED_ON < " + self.config.ubbqTestLimitToBeforeTimestampSeconds.forums : ""),

            function(err, rows){
                logger.info("Forums query came back with " + rows.length + " records, now writing to tmp dir, please be patient.");
                if (err) throw err;
                self.ubbData.forums = self._convertListToMap(rows, "_ofid");
                self.saveMap(self.config.ubbTmpFiles.forums, self.ubbData.forums, rows.length, "UBB Forums", next);
            });
    },

    // get ubb topics
    ubbGetTopics: function(next) {
        var self = this;
        this.ubbq(
            "SELECT TOPIC_ID as _otid, FORUM_ID as _forumId, POST_ID as _postId, "
                + " USER_ID as _userId, TOPIC_VIEWS as _views, "
                + " TOPIC_SUBJECT as _title, TOPIC_REPLIES as _replies, "
                + " TOPIC_TOTAL_RATES as _totalRates, TOPIC_RATING as _rating, "
                + " TOPIC_CREATED_TIME as _datetime, TOPIC_IS_APPROVED as _approved, "
                + " TOPIC_STATUS as _status, TOPIC_IS_STICKY as _pinned "
                + " FROM " + self.config.ubbTablePrefix + "TOPICS "
                + (self.config.ubbqTestLimitToBeforeTimestampSeconds.topics ?
                "WHERE TOPIC_CREATED_TIME < " + self.config.ubbqTestLimitToBeforeTimestampSeconds.topics : ""),

            function(err, rows){
                logger.info("Topics query came back with " + rows.length + " records, now writing to tmp dir, please be patient.");
                if (err) throw err;
                self.ubbData.topics = self._convertListToMap(rows, "_otid");
                next();
            });
    },

    // get ubb forums
    ubbGetPosts: function(next) {
        var self = this;
        this.ubbq(
            "SELECT POST_ID as _opid, POST_PARENT_ID as _parent, POST_PARENT_USER_ID as _parentUserId, TOPIC_ID as _topicId, "
                + "POST_POSTED_TIME as _datetime, POST_SUBJECT as _subject, "
                + "POST_BODY as _body, USER_ID as _userId, "
                + "POST_MARKUP_TYPE as _markup, POST_IS_APPROVED as _approved "
                + "FROM " + self.config.ubbTablePrefix + "POSTS "
                + (self.config.ubbqTestLimitToBeforeTimestampSeconds.posts ?  "WHERE POST_POSTED_TIME < " + self.config.ubbqTestLimitToBeforeTimestampSeconds.posts : ""),

            function(err, rows){
                console.log(err);

                logger.info("Posts query came back with " + rows.length + " records, now writing to tmp dir, please be patient.");
                if (err) throw err;
                self.ubbData.posts = self._convertListToMap(rows, "_opid", function(item){
                    if (item._parent == 0 && item._topicId && self.ubbData.topics[item._topicId]) {
                        self.ubbData.topics[item._topicId]._firstPost = item;
                    }
                    return item;
                });

                self.saveMap(self.config.ubbTmpFiles.topics, self.ubbData.topics, "a large number of", "UBB Topics", function(){
                    logger.info("hang on now writing posts to tmp dir... that could take a while.");
                    self.saveMap(self.config.ubbTmpFiles.posts, self.ubbData.posts, rows.length, "UBB Posts", next);
                });
            });
    },

// save the UBB users to nbb's redis
    nbbSaveUsers: function(next) {
        var self = this;
        var users = require(this.config.ubbTmpFiles.users);
        var _users = Object.keys(users);


        // iterate over each
        async.eachSeries(_users, function(key, save) {
            // get the data from db
            var user = users[key];

            logger.debug("[idx: " + key + "] saving user: " + user.username);
            User.create(user.username, user.password, user.email, function(err, uid) {
                if (err) {
                    logger.error(" username: " + user.username + " -- " + err);
                } else {
                    // saving that for the map
                    user.uid = uid;

                    var reputation = 0;
                    if (user._level == "Moderator") {
                        reputation = self.config.ubbToNbbModeratorsAddedReputation + user._rating;
                        Group.join(nbbData.groups.Moderators.gid, uid, function(){
                            logger.info(user.username + " became a moderator");
                        });
                    } else if (user._level == "Administrator") {
                        reputation = self.config.ubbToNbbModeratorsAddedReputation + user._rating;
                        Group.join(nbbData.groups.Administrators.gid, uid, function(){
                            logger.info(user.username + " became an Administrator");
                        });
                    } else {
                        reputation = user._rating || 0;
                    }

                    // set some of the fields got from the ubb
                    var _u_ = {
                        // preseve the signature and website if there is any
                        signature: user.signatureMd,
                        website: user.website || "",
                        // if that user is banned, we would still h/im/er to be
                        banned: user._banned,
                        // reset the location
                        location: user._location || "",
                        // preserse the  joindate, luckily here, ubb uses timestamps too
                        joindate: user._joindate,
                        // that's the best I could come up with I guess
                        reputation: reputation || 0,
                        profileviews: user._totalRates
                    };

                    if (user.avatar) {
                        _u_.gravatarpicture = user.avatar;
                        _u_.picture = user.avatar;
                        user.customPicture = true;
                    }
                    user.redirectRule = self.redirectRule("users/" + user._ouid + "/" + user._username + "/", "user/" + user.userslug);
                    user = $.extend({}, user, _u_);
                    self.ubbToNbbMap.users[user._ouid] = user;
                    User.setUserFields(uid, _u_);

                    if (self.config.nbbAutoConfirmEmails)
                        RDB.set('email:' + user.email + ':confirm', true);
                }
                save();
            });
        }, function(){

            if (self.config.nbbAutoConfirmEmails)
                RDB.keys("confirm:*:email", function(err, keys){
                    keys.forEach(function(key){
                        RDB.del(key);
                    });
                });
            self.saveMap(self.config.nbbTmpFiles.users, self.ubbToNbbMap.users, _users.length, "NBB Users", next, "_ouid");
        });
    },

    saveMap: function(file, map, length, wat, next, key) {
        if (typeof map == "array" && key)
            map = this._convertListToMap(map, key);
        // just save a copy in my big ubbToNbbMap for later, minus the correct website and avatar, who cares for now.
        this.slowWriteJSONtoFile(file, map, function(_err) {
            if (!_err)
                logger.info(length + " " + wat + " saved, MAP in " + file);
            else
                logger.error("Could not write NBB Users " + _err);

            if (typeof next == "function")
                next();
        });
    },

    redirectRule: function(from, to) {
        var res = this.config.nginx.rule.replace("${FROM}", from).replace("${TO}", to);
        logger.info(res);
        return res;
    },

// save the UBB categories to nbb's redis
// ubb.forums == nbb.categories
    nbbSaveCategories: function(next){
        var categories = require(this.config.ubbTmpFiles.forums);
        var self = this;
        var _categories = Object.keys(categories);
        var _order = 0;

        // iterate over each
        async.eachSeries(_categories, function(key, save) {
            // get the data from db
            var category = categories[key];

            // set some defaults since i don't have them
            category.icon = self.config.nbbCategoriesIcons[Math.floor(Math.random()*self.config.nbbCategoriesIcons.length)];
            category.blockclass = self.config.nbbCategoriesColorClasses[Math.floor(Math.random()*self.config.nbbCategoriesColorClasses.length)];

            // order based on index i guess
            category.order = _order++ + 1;

            category.name = category._name;
            category.description = category._description;

            logger.debug("[idx:" + key + "] saving category: " + category.name);
            Categories.create(category, function(err, categoryData) {
                if (err) {
                    logger.error(err);
                } else {
                    categoryData.redirectRule = self.redirectRule("forums/" + category._ofid + "/", "category/" + categoryData.slug);

                    category = $.extend({}, category, categoryData);

                    // save a reference from the old category to the new one
                    self.ubbToNbbMap.categories[category._ofid] = category;
                }
                save();
            })
        }, function(){
                self.saveMap(self.config.nbbTmpFiles.categories, self.ubbToNbbMap.categories, _categories.length, "NBB Categories", next, "_ofid");
        });
    },

// save the UBB topics to nbb's redis
    nbbSaveTopics: function(next){
        // topics chez nbb are forums chez ubb
        var topics = require(this.config.ubbTmpFiles.topics);
        var users = require(this.config.nbbTmpFiles.users);
        var categories = require(this.config.nbbTmpFiles.categories);

        // var posts = require(this.config.ubbTmpFiles.posts);

        var self = this;
        var _topics = Object.keys(topics);

        async.eachSeries(_topics, function(key, save) {
                // get the data from db
                var topic = topics[key];

                // if that's the *DoNotDelete* use created by ubb, then let's assign that post to the initial user by nbb
                if (!users[topic._userId] && topic._userId == 1) {
                    users[topic._userId] = {
                        uid: 1
                    };
                }

                if (!topic._firstPost || !topic._forumId || !topic._userId || !users[topic._userId] || !categories[topic._forumId] || !topic._firstPost._body) {
                    var requiredValues = [topic._firstPost, topic._forumId, topic._userId, users[topic._userId], categories[topic._forumId], (topic._firstPost || {})._body];
                    var requiredKeys = ["topic._firstPost", "topic._forumId", "topic._userId", "users[topic._userId]", "categories[topic._forumId]", "topic._firstPost._body"];
                    var falsyIndex = self.whichIsFalsy(requiredValues);
                    logger.warn("Skipping topic: " + topic._otid + " titled: " + topic._title + " because " + requiredKeys[falsyIndex] + " is falsy. Value: " + requiredValues[falsyIndex]);
                    save();
                } else {

                    // from s to ms
                    var time = topic._datetime * 1000;

                    var _t_ = {
                        categoryId: categories[topic._forumId].cid,
                        uid: users[topic._userId].uid,
                        content: self.hazHtml(topic._firstPost._body || "") ? htmlToMarkdown(topic._firstPost._body || "") : topic._firstPost._body || "",
                        title: topic._title ? topic._title[0].toUpperCase() + topic._title.substr(1) : "Untitled",
                        timestamp: time,
                        relativeTime: new Date(time).toISOString(),
                        viewcount: topic._views,
                        pinned: topic._pinned
                    };

                    logger.debug("[idx:" + key + "] saving topic: " + _t_.title);
                    Topics.post(_t_.uid, _t_.title, _t_.content, _t_.categoryId, function(err, ret){
                        if (err) {
                            logger.error(err);
                            save();
                        } else {
                            ret.topicData.redirectRule = self.redirectRule("topics/" + topic._otid + "/", "topic/" + ret.topicData.tid + "/" + ret.topicData.slug);
                            ret.topicData = $.extend({}, ret.topicData, _t_);

                            Topics.setTopicField(ret.topicData.tid, "timestamp", _t_.timestamp);
                            Topics.setTopicField(ret.topicData.tid, "viewcount", _t_.viewcount);
                            Topics.setTopicField(ret.topicData.tid, "pinned", _t_.pinned);

                            Posts.setPostField(ret.postData.pid, "timestamp", _t_.timestamp, function (){
                                Posts.setPostField(ret.postData.pid, "relativeTime", _t_.relativeTime, function (){
                                    // save a reference from the old category to the new one
                                    self.ubbToNbbMap.topics[topic._otid] = ret.topicData;
                                    save();
                                });
                            });
                        }
                    });
                }
            },
            function (){
                self.saveMap(self.config.nbbTmpFiles.topics, self.ubbToNbbMap.topics, _topics.length, "NBB Topics", next, "_otid");
            }
        );
    },

// save the UBB posts to nbb's redis
    nbbSavePosts: function(next){
        var posts = require(this.config.ubbTmpFiles.posts);

        var self = this;
        var _posts = Object.keys(posts);

        // iterate over each
        async.eachSeries(_posts, function(key, save) {
                // get the data from db
                var post = posts[key];

                // if that's the *DoNotDelete* use created by ubb, then let's assign that post to the initial user by nbb
                if (!self.ubbToNbbMap.users[post._userId] && post._userId == 1) {
                    self.ubbToNbbMap.users[post._userId] = {
                        uid: 1
                    };
                }

                var topic = self.ubbToNbbMap.topics[post._topicId];
                var user = self.ubbToNbbMap.users[post._userId];

                // if this is a topic post, used for the topic's content
                if (!post._parent || !topic || !user || !post._body) {
                    var requiredValues = [post._parent, topic, user, post._body];
                    var requiredKeys = ["post._parent", "topic", "user", "post_.body"];
                    var falsyIndex = self.whichIsFalsy(requiredValues);
                    logger.warn("Skipping post: " + post._opid + " because " + requiredKeys[falsyIndex] + " is falsy. Value: " + requiredValues[falsyIndex]);
                    save();
                } else {

                    // from s to ms
                    var time = post._datetime * 1000;

                    var _p_ = {
                        tid: self.ubbToNbbMap.topics[post._topicId].tid,
                        uid: self.ubbToNbbMap.users[post._userId].uid,
                        content: self.hazHtml(post._body) ? htmlToMarkdown(post._body) : post._body,
                        timestamp: time,
                        relativeTime: new Date(time).toISOString()
                    };

                    logger.debug("[idx:" + key + "] saving post: " + post._opid);
                    Posts.create(_p_.uid, _p_.tid, _p_.content, function(err, postData){
                        if (err) {
                            logger.error(err);
                        } else {

                            postData.redirectRule = self.redirectRule("topics/" + post._topicId + "/(.)*#Post" + post._opid, "topic/" + _p_.tid + "#" + postData.pid);

                            postData = $.extend({}, post, postData);

                            Posts.setPostField(postData.pid, "timestamp", _p_.timestamp, function (){
                                Posts.setPostField(postData.pid, "relativeTime", _p_.relativeTime, function (){

                                    // save a reference from the old category to the new one
                                    self.ubbToNbbMap.posts[post._opid] = postData;
                                });
                            });
                        }
                        save();
                    });
                }
            },
            function(){
                self.saveMap(self.config.nbbTmpFiles.posts, self.ubbToNbbMap.posts, _posts.length, "NBB Posts", next);
            });
    },

// helpers

    exit: function(code){
        logger.info("Exiting ... ");
        this.ubbDisconnect();
        process.exit(this.isNumber(code) ? code : 0);
    },

// disconnect from the ubb mysql database
    ubbDisconnect: function(){
        this.ubbConnection.end();
    },

// query ubb mysql database
    ubbq: function(q, callback){
        this.ubbConnection.query(q, callback);
    },

    whichIsFalsy: function(arr){
        for (var i = 0; i < arr.length; i++) {
            if (!arr[i])
                return i;
        }
        return null;
    },

// writing json to file slowly, prop by prop to avoid Out of memory errors
    slowWriteJSONtoFile: function(file, json, callback) {
        fs.writeFileSync(file, "{");
        var first = true;
        for(var prop in json) {
            if(json.hasOwnProperty(prop)) {
                if(first)
                    first = false;
                else
                    fs.appendFileSync(file, ",\n");

                fs.appendFileSync(file, JSON.stringify(prop, null, 4) + ":" + JSON.stringify(json[prop], null, 4));
            }
        }
        fs.appendFileSync(file, "}\n");

        callback(null);
    },

// writing json to file prop by prop to avoid Out of memory errors
    writeJSONtoFile: function(file, json, callback) {
        fs.writeFile(file, JSON.stringify(json, null, 4), callback);
    },

// yea, for faster lookup
    _convertListToMap: function(list, key, fn){
        var map = {};
        var f = typeof fn == "function";

        list.forEach(function(item) {
            if (f)
                item = fn(item);

            map[item[key]] = item;
        });
        return map;
    },

// check if valid url
    _isValidUrl: function(url){
        var pattern = /^(?!mailto:)(?:(?:https?|ftp):\/\/)?(?:\S+(?::\S*)?@)?(?:(?:(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\u00a1-\uffff0-9]+-?)*[a-z\u00a1-\uffff0-9]+)(?:\.(?:[a-z\u00a1-\uffff0-9]+-?)*[a-z\u00a1-\uffff0-9]+)*(?:\.(?:[a-z\u00a1-\uffff]{2,})))|localhost)(?::\d{2,5})?(?:\/[^\s]*)?$/i;

        if (!url || !url.match(pattern) || url.length > 2083) {
            return false;
        }
        return true;
    },

// check if valid url
    _isValidUrlSimple: function(url){
        // no ftp allowed and length must be > 10 .. whatever.
        return url && url.indexOf("http") == 0 && url.length > 10 && url.length <= 2083;
    },

// a helper method to generate temporary passwords
    _genRandPwd: function(len, chars) {
        var index = (Math.random() * (chars.length - 1)).toFixed(0);
        return len > 0 ? chars[index] + this._genRandPwd(len - 1, chars) : '';
    },

    _checkUrlResponse: function(url, callback) {
        http.get(url, function(res) {
            res.on("data", function(c){
                callback(true);
            });
            res.on("end", function() {
            });
            res.on("error", function() {
                callback(false)
            });
        });
    },

    truncateStr : function (str, len) {
        if (typeof str != "string") return str;
        len = this.isNumber(len) && len > 3 ? len : 20;
        return str.length <= len ? str : str.substr(0, len - 3) + "...";
    },

    isNumber : function (n) {
        return !isNaN(parseFloat(n)) && isFinite(n);
    },

    hasNumber : function (n) {
        return !isNaN(parseFloat(n));
    },

    monthWord : function (i) {
        return (function(){return {0: "Jan", 1: "Feb", 2: "Mar", 3: "Apr", 4: "May", 5: "Jun",
            6: "Jul", 7: "Aug", 8: "Sep", 9: "Oct", 10: "Nov", 11: "Dec" }})()[i];
    },

// todo: i think I got that right?
    cleanUsername: function(str) {
        str = str.replace(/[^\u00BF-\u1FFF\u2C00-\uD7FF\-.*\w\s]/gi, '');
        // todo: i don't know what I'm doing HALP
        return str.replace(/ /g,'').replace(/\*/g, '').replace(/æ/g, '').replace(/ø/g, '').replace(/å/g, '');
    },

    hazHtml: function(str){
        return !!str.match(/<[a-z][\s\S]*>/i);
    }
};