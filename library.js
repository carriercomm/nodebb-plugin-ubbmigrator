var

// NodeBB Objects
    Categories = module.parent.require('./categories'),
    User = module.parent.require('./user'),
    Topic = module.parent.require('./topics'),
    Posts = module.parent.require('./posts'),

// some useful modules
// mysql to talk to ubb db
    mysql = require("mysql"),
// exactly what it means, ubb uses html for some posts, nbb uses markdown, right?
    htmlToMarkdown = require("html-md"),
// I'm lazy
    $ = require("jquery"),
// you know what these are if you're looking at this source
    fs = require("fs"),
    http = require("http"),

// todo: move this to a config file
    ubbConfig =  {
        host: "127.0.0.1",
        user: "ubb_user",
        password: "password",
        database: "ubb_test"
    },
    ubbPrefix = "ubbt_",

// mysql connection to ubb database
    ubbConnection = mysql.createConnection(ubbConfig),
// ubbData in memory for a little while
    ubbData = {
        users: [],
        usersProfiles: [],
        categories: [],
        forums: [],
        posts: []
    },

// ubb to nbb map in memory
    MAP = {
        categories: {},
        users: {},
        topics: {},
        posts: {}
    };

module.exports = {

    // save the UBB categories to NodeBB's redis
    nbbSaveCategories: function(){
        var categories = require("./tmp/ubb/categories.json");

        // iterate over each
        Object.keys(categories).forEach(function(key, ci){
            // get the data from db
            var data = categories[key];

            // set some defaults since i don't have them
            data.icon = "icon-comment";
            data.blockclass = "category-blue";

            // order based on index i guess
            data.order = ci + 1;

            Categories.create(data, function(err, category){
                if (err) throw err;

                // save a reference from the old category to the new one
                MAP.categories[data.id] = category;

                console.log("[ubbmigrator] [ubb][" + data.id + "]--->[nbb][/category/" + category.cid + "/" + category.slug);
            })
        });
    },

    // save the UBB users to NodeBB's redis
    nbbSaveUsers: function() {
        var self = this;
        var users = require("./tmp/ubb/users.json");
        var chars = '!@#$?)({}*.^qwertyuiopasdfghjklzxcvbnmQWERTYUIOPASDFGHJKLZXCVBNM1234567890';

        // iterate over each
        Object.keys(users).forEach(function(key, ui){
            // get the data from db
            var data = users[key];

            // just being safe
            data.username = data.username ? data.username.toLowerCase() : "";

            // lower case the email as well, but I won't use it for the creation of the user
            // NodeBB tries to send an email at the creation of the user account
            // so after looking at nodebb source, it looks like i can get away with setting some
            // email that doesn't work, but still validates, then after I set it back to the original email
            data.realEmail = data.email ? data.email.toLowerCase() : "";
            // todo: i should probably move that to a config, just in case you don't want to do that
            // also that will mess up the gravatar generated url, so I fix that at the end of each iteration, keep scrolling
            data.email = "unique.email.that.doesnt.work." + ui + "@but.still.validates.nodebb.check.so";

            // I don't know about you about I noticed a lot my users have incomplete urls
            data.avatar = self._isValidUrl(data.avatar) ? data.avatar : undefined;
            data.homepage = self._isValidUrl(data.homepage) ? data.homepage : undefined;

            // generate a temp password, don't worry i'll add the clear text to the map so you can email it to the user
            // todo: maybe make these 2 params as configs
            data.password = this._genRandPwd(13, chars);

            User.create(data.username, data.password, data.email, function(err, uid){
                if (err) throw err;

                User.getUserField(uid, "userslug", function(err, userslug){

                    data.userslug = userslug;

                    // todo: take out the password out of the log
                    console.log("[ubbmigrator] [ubb][" + data.id + "]--->[nbb][/user/" + userslug + "?udi=" + uid + "&pwd=" + data.password);

                    // set some of the fields got from the ubb
                    User.setUserFields(uid, {
                        // preseve the signature and homepage if there is any
                        signature: htmlToMarkdown(data.signature),
                        website: data.homepage || "",
                        // if that user is banned, we would still h/im/er to be
                        banned: data.banned,
                        // reset the location
                        location: data.location || "",
                        // preserse the  joindate, luckily here, ubb uses timestamps too
                        joindate: data.created_at,
                        // now I set the real email back in
                        email: data.realEmail
                    });
                });

                // some sanity async checks
                self._checkUrlResponse(data.homepage, function(result){
                    // if it's not good
                    if (!result) {
                        User.setUserField(uid, "website", "", function(){
                            console.log("[ubbmigrator] User[" + uid + "].website[" + data.homepage + "] reset to ");
                        });

                    }
                });
                self._checkUrlResponse(data.avatar, function(result){
                    var picUrl;
                    // if it's not good
                    if (!result) {
                        picUrl = "";
                    } else {
                        // NodeBB creates an avatar url so, if the user have an older one and still good, we keep it
                        // if not we try to create a gravatar from the realEmail not the fake one we created on top
                        picUrl = User.createGravatarURLFromEmail(data.realEmail);
                    }
                    User.setUserField(uid, "picture", picUrl, function(){
                        console.log("[ubbmigrator] User[" + uid + "].picture:[" + data.avatar + "] reset to " + picUrl);
                    });
                    User.setUserField(uid, "gravatarpicture", picUrl, function(){
                        console.log("[ubbmigrator] User[" + uid + "].gravatarpicture:[" + data.avatar + "] reset to " + picUrl);
                    });
                });
            })
        });
    },


    // connect to the ubb database
    ubbConnect: function(cb){
        cb = typeof cb == "function" ? cb : function(){};
        var self = this;

        console.log("[ubbmigrator] ubbConnect Called; ubbConnected: " + self.ubbConnected);

        if (!self.ubbConnected) {
            ubbConnection.connect(function(err){
                if (err) {
                    self.ubbConnected = false;
                    // debugger;
                    // throw err;
                    cb();
                } else {
                    self.ubbConnected = true;
                    cb();
                }
            });
        } else {
            cb();
        }
    },

    // disconnect from the ubb mysql database
    ubbDisconnect: function(){
        ubbConnection.end();
        this.ubbConnected = false;
    },

    // query ubb mysql database
    ubbq: function(q, cb){
        this.ubbConnect(function(){
            ubbConnection.query(q, cb);
        });
    },

    writeJSONtoFile: function(file, json, cb){
        fs.writeFile(file, JSON.stringify(json, null, 4), cb);
    },

    throttleSelectQuery: function(columnsString, table, options) {
        options = options || {};
        options.limit = options.limit || 1000;
        options.queryCallback = options.queryCallback || function(){};

        var self = this;

        var total = 0;
        this.ubbq("SELECT COUNT(*) as total FROM " + table, function(err, rows){

            if (rows.length)
                total = rows[0]['total'] || 0;

            var funcs = [];

            var createfunc = function (i, total) {
                return function(a, b, c) {
                    return options.queryCallback(a, b, c, i >= total);
                };
            };

            for (var i = options.limit; i < total + options.limit; ) {
                funcs[i] = createfunc(i, total);
                i += options.limit;
            }

            for (var j = options.limit; j < total + options.limit; ) {
                var q = "SELECT " + columnsString + " FROM " + table + " LIMIT " + (j - options.limit) + ", "+ options.limit;
                // console.log(q);
                self.ubbq(q, funcs[j]);
                j += options.limit;
            }
        });
    },

    // get ubb users
    ubbGetUsers: function() {
        var self = this;
        this.throttleSelectQuery(
            // select
            "USER_ID as id, USER_LOGIN_NAME as username, USER_REGISTRATION_EMAIL as email,"
                + " USER_MEMBERSHIP_LEVEL as level, USER_REGISTERED_ON as created_at,"
                + " USER_IS_APPROVED as approved, USER_IS_banned as banned",
            // from
            "ubbPrefixUSERS",
            {
                queryCallback: function(err, rows, fields, lastOne){
                    if (err) throw err;
                    ubbData.users = ubbData.users.concat(rows);


                    if (lastOne) {
                        console.log("[ubbmigrator] USERS: " + ubbData.users.length);
                        ubbData.users = self.convertListToMap(ubbData.users, "id");
                        self.ubbGetUsersProfiles(ubbData.users);
                    }
                }
            }
        );
    },

    convertListToMap: function(list, key){
        var map = {};
        list.forEach(function(item, ii) {
            map[item[key]] = item;
        });
        return map;
    },

    // get ubb users profiles
    ubbGetUsersProfiles: function(users) {
        var self = this;
        this.throttleSelectQuery(

            // select
            "USER_ID as id, USER_SIGNATURE as signature, USER_HOMEPAGE as homepage,"
                + " USER_OCCUPATION as occupation, USER_LOCATION as location,"
                + " USER_AVATAR as avatar, USER_TITLE as title,"
                + " USER_POSTS_PER_TOPIC as posts_per_topic, USER_TEMPORARY_PASSWORD as temp_password,"
                + " USER_TOTAL_POSTS as total_posts, USER_RATING as rating,"
                + " USER_TOTAL_RATES as total_rates, USER_BIRTHDAY as birthday,"
                + " USER_UNVERIFIED_EMAIL as unverified_email",
            // from
            "ubbPrefixUSER_PROFILE",
            {
                queryCallback: function(err, rows, fields, lastOne){
                    if (err) throw err;
                    ubbData.usersProfiles = ubbData.usersProfiles.concat(rows);

                    if (lastOne) {
                        console.log("[ubbmigrator] USERS PROFILE: " + ubbData.usersProfiles.length);
                        ubbData.usersProfiles.forEach(function(profile){
                            ubbData.users[profile.id] = $.extend({}, profile, ubbData.users[profile.id]);
                        });

                        self.writeJSONtoFile("tmp/ubb/users.json", ubbData.users, function(err){
                            if(!err)
                                console.log("[ubbmigrator] USERS-SAVED");
                            else
                                console.log("[ubbmigrator] USERS-SAVING ERROR: " + err);
                        })
                    }
                }
            }
        );
    },

    // get ubb categories
    ubbGetCategories: function() {
        var self = this;
        this.throttleSelectQuery(
            // select
            "CATEGORY_ID as oid, CATEGORY_TITLE as name, CATEGORY_DESCRIPTION as description",
            // from
            "ubbPrefixCATEGORIES",
            {
                queryCallback: function(err, rows, fields, lastOne){
                    if (err) throw err;
                    ubbData.categories = ubbData.categories.concat(rows);
                    if (lastOne) {
                        console.log("[ubbmigrator] CATEGORIES: " + ubbData.categories.length);
                        self.writeJSONtoFile("tmp/ubb/categories.json", ubbData.categories, function(err){
                            if(!err)
                                console.log("[ubbmigrator] CATEGORIES-SAVED");
                            else
                                console.log("[ubbmigrator] CATEGORIES-SAVING ERROR: " + err);
                        })
                    }

                }
            }
        );
    },

    _normalizeCategoties: function(rows){
        return rows.map(function(row, i){
            row["blockclass"] = ""
        });
    },

    // get ubb forums
    ubbGetForums: function() {
        var self = this;
        this.throttleSelectQuery(
            // select
            "FORUM_ID as id, FORUM_TITLE as title, FORUM_DESCRIPTION as description,"
                + " CATEGORY_ID as category_id, FORUM_CREATED_ON as created_at",
            // from
            "ubbPrefixFORUMS",
            {
                queryCallback: function(err, rows, fields, lastOne){
                    if (err) throw err;
                    ubbData.forums = ubbData.forums.concat(rows);
                    if (lastOne) {
                        console.log("[ubbmigrator] FORUMS: " + ubbData.forums.length);
                        self.writeJSONtoFile("tmp/ubb/forums.json", ubbData.forums, function(err){
                            if(!err)
                                console.log("[ubbmigrator] FORUMS-SAVED");
                            else
                                console.log("[ubbmigrator] FORUMS-SAVING ERROR: " + err);
                        })
                    }
                }
            }
        );
    },

    // get ubb forums
    ubbGetPosts: function() {
        var self = this;
        this.throttleSelectQuery(
            // select
            "POST_ID as id, POST_PARENT_ID as parent, POST_PARENT_USER_ID as parent_user_id, TOPIC_ID as topic_id,"
                + " POST_POSTED_TIME as created_at, POST_SUBJECT as subject,"
                + " POST_BODY as body, POST_DEFAULT_BODY as default_body,",
            + " USER_ID as user_id, POST_DEFAULT_BODY as default_body,",
            + " POST_MARKUP_TYPE as markup, POST_IS_APPROVED as approved",
            // from
            "ubbPrefixPOSTS",
            {
                queryCallback: function(err, rows, fields, lastOne){
                    if (err) throw err;
                    ubbData.posts = ubbData.posts.concat(rows);
                    if (lastOne) {
                        console.log("[ubbmigrator] POSTS: " + ubbData.posts.length);
                        self.writeJSONtoFile("tmp/ubb/posts.json", ubbData.posts, function(err){
                            if(!err)
                                console.log("[ubbmigrator] POSTS-SAVED");
                            else
                                console.log("[ubbmigrator] POSTS-SAVING ERROR: " + err);
                        })
                    }
                }
            }
        );
    },

    // check if valid url
    _isValidUrl: function(url){

        var pattern = new RegExp(
            + "^(https?:\\/\\/)?"
                + "((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|"
                + "((\\d{1,3}\\.){3}\\d{1,3}))"
                + "(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*"
                + "(\\?[;&a-z\\d%_.~+=-]*)?"
                + "(\\#[-a-z\\d_]*)?$", "i");

        if(!pattern.test(url)) {
            return false;
        } else {
            return true;
        }
    },

    // a helper method to generate temporary passwords
    _genRandPwd: function(len, chars) {
        var index = (Math.random() * (chars.length - 1)).toFixed(0);
        return len > 0 ? chars[index] + this._genRandPwd(len - 1, chars) : '';
    },

    _checkUrlResponse: function(url, callback) {
        http.get(url, function(res) {
            res.on("data", function(c){});
            res.on("end", function() {
                callback(true);
            });
            res.on("error", function() {
                callback(false)
            });
        });
    }
};