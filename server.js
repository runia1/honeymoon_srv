/**
 * Created by mar on 3/3/17.
 */

'use strict';

import "babel-polyfill";
import { Server as WebSocketServer } from 'uws';
import { MongoClient, ObjectId } from 'mongodb';
import braintree from 'braintree';

// GENERATOR makes objects easy to loop over in key value fashion.
function* it(obj) {
    for (let key of Object.keys(obj)) {
        yield [key, obj[key]];
    }
}


// BRAINTREE SERVER IMPLEMENTATION
const braintreeCredentials = require('../keys/braintree.json');
const gateway = braintree.connect({
    environment: braintree.Environment.Sandbox,
    merchantId: braintreeCredentials.merchantId,
    publicKey: braintreeCredentials.publicKey,
    privateKey: braintreeCredentials.privateKey
});


// MONGO WRAPPER
const mongoCredentials = require('../keys/mongo.json');
const mongoUrl = 'mongodb://'+mongoCredentials.user+':'+mongoCredentials.pwd+'@localhost:27017/honeymoon?authMechanism='+mongoCredentials.authMechanism+'&authSource='+mongoCredentials.authSource;
const getConnection = () => {
    return new Promise((resolve, reject) => {
        MongoClient.connect(mongoUrl, (err, db) => {
            if(err) {
                reject('Error connecting to database.');
            }
            else {
                resolve(db);
            }
        });
    });
};

// APPLICATION SERVER
let currentConnections = {};
let currentPushSubscriptions = {};

const wss = new WebSocketServer({ port: 8081});
wss.on('connection', ws => {
    // Set up some handlers for socket events
    
    ws.on('message', message => {
        try {
            let action = JSON.parse(message);
            
            //kick off the process.
            dataLayer(ws, action);
        } catch (e) {
            // something went wrong...
            console.error(e.message);
        }
    });
    
    ws.on('close', () => {
        dataLayer(ws, {
            type: "CONNECTION_CLOSED"
        });
    });
});

/**
 * Update data in DB.
 * 
 * @param ws
 * @param action
 */
const dataLayer = (ws, action) => {
    switch(action.type) {
        case 'CONNECTION_OPEN':
            
            return new Promise((resolve, reject) => {
                gateway.clientToken.generate({}, (err, response) => {
                    if (err) {
                        reject(err);
                    }
                    
                    resolve(response);
                });  
            }).then((response) => {
                ws.data.clientToken = response.clientToken;
                
                // lets get a db connection
                return getConnection();
            }).then((db) => {
                // lets build them an initial state...
                
                // insert a new annonymous user
                let user = db.collection('users').insertOne({
                    //TODO: ip, ctime, etc,. ?
                });
                let registry = db.collection('registry').find({}).toArray();
                let gifts = db.collection('gifts').find({}).toArray();

                return Promise.all([user, registry, gifts]);
            }).then((values) => {
                ws.data.user = values[0];
                ws.data.registry = values[1];
                // TODO: remove the amount from gifts so other users can't see how much others gave...
                ws.data.gifts = values[2];

                action = {
                    type: "CONNECTION_OPENED",
                    state: ws.data
                };
                // Store handle to this connection for later
                currentConnections[ws.data.user._id] = ws;
                notificationLayer(ws, action);

            }).catch((error) => {
                console.error(error);
                
                action = {
                    type: "CONNECTION_OPEN_ERROR",
                    message: error
                };
                notificationLayer(ws, action);
            });
            break;
        
        case 'CONNECTION_CLOSED':
            // remove from currentConnections
            delete currentConnections[ws.data.user._id];
            action = { 
                type: "CONNECTION_CLOSED",
                userId: ws.data.user._id
            };
            break;
        
        case 'GIFT_CREATE':
            //TODO: validate that action.data has all needed data.
            
            // attempt to make trxn with gateway
            return new Promise((resolve, reject) => {
                gateway.transaction.sale({
                    amount: action.data.amount,
                    paymentMethodNonce: action.data.paymentMethodNonce,
                    options: {
                        submitForSettlement: true
                    }
                }, (err, result) => {
                    if (err) {
                        reject(err);
                    }
                    else if (!result.success) {
                        reject(result.errors.deepErrors());
                    }
                    else {
                        resolve(result);
                    }
                });
            }).then((result) => {
                action.data.transaction = result.transaction;
                
                return getConnection();
            }).then((db) => {
                // update DB, return result.
                
                // update user's nickname with gift's nickname data
                let res0 = db.collection('users').updateOne({
                    _id: ObjectId(ws.data.user._id)
                },
                {
                    $set: {
                        nickname: action.data.nickname
                    }
                });

                // insert new gift
                const gift = {
                    userId: ws.data.user._id,
                    amount: action.data.amount,
                    comment: action.data.comment,
                    registryId: action.data.registryId,
                    transaction: action.data.transaction
                };
                let res1 = db.collection('gifts').insertOne(gift);

                // update registry item totalGiven that this is gifted towards
                let res2 = db.collection('registry').updateOne({
                    _id: ObjectId(action.data.registryId)
                },
                {
                    $inc: {
                        totalGiven: action.data.amount
                    }
                });

                // run these first...
                return Promise.all([res0, res1, res2]);
            }).then((results) => {
                // TODO: validate results from first two queries

                // now get updated list of registry items to send back
                //return db.collection('registry').find({}).toArray();
                return db.collection('registry').aggregate([{
                    $lookup: {
                        from: "gifts",
                        localField: "_id",
                        foreignField: "registryId",
                        as: "comments"
                    }
                },
                {
                    $project: {
                        "comments._id": 0,
                        "comments.amount": 0,
                        "comments.registryId": 0
                    }
                }]).toArray();
                
            }).then((updatedRegistry) => {
                action = {
                    type: "GIFT_CREATED",
                    data: updatedRegistry
                };
                notificationLayer(ws, action);

            }).catch((error) => {
                action = {
                    type: "GIFT_CREATE_ERROR",
                    message: error
                };
                notificationLayer(ws, action);
            });
            break;
            
        /*
        case 'USER_UPDATE':
            runQuery((db) => {
                //TODO: validate that action.data has all needed data.
                
                // NOTE: we do not allow them to update their password through this action
                let user = {
                    email: action.data.email,
                    fname: action.data.fname,
                    lname: action.data.lname
                };

                try {
                    const result = db.collection('users').updateOne(
                        { _id: action.data._id },
                        { $set: user }
                    );

                    if (!result.modifiedCount) {
                        throw new Error("Could not find user in DB.");
                    }
                    else {
                        user._id = action.data._id;

                        action = {
                            type: "USER_UPDATED",
                            data: user
                        };
                    }
                }
                catch(e) {
                    action = {
                        type: "USER_UPDATE_ERROR",
                        message: e
                    };
                }
            });
            break;
            
        case 'USER_DELETE':
            runQuery((db) => {
                try {
                    const user = db.collection('users').findOne({ _id: action.data._id});

                    // pull user id out of "users" and "admins" for these events.
                    db.collection('events').updateMany(
                        { _id: { $in: user.events } },
                        { $pull: { users: action.data._id, admins: action.data._id } }
                    );

                    // pull user id out of "users" and "admins" for these groups.
                    db.collection('groups').updateMany(
                        { _id: { $in: user.groups } },
                        { $pull: { users: action.data._id, admins: action.data._id } }
                    );
                    
                    // delete user
                    const result = db.collection('users').deleteOne(
                        { _id: action.data._id }
                    );

                    if (!result.deletedCount) {
                        throw new Error("Could not find user in DB.");
                    }
                    else {
                        action = {
                            type: "USER_DELETED",
                            userId: action.data._id
                        };
                    }
                }
                catch(e) {
                    action = {
                        type: "USER_DELETE_ERROR",
                        message: e
                    };
                }
            });
            break;
        */
    }
};

/**
 * Notify the other users that need to know about this action.
 * 
 * @param ws
 * @param action
 */
const notificationLayer = (ws, action) => {
    let userIds;
    
    switch(action.type) {
        case 'CONNECTION_OPENED':
            // the user just opened the app, lets tell the other users he's online.
            userIds = 'connected';
            notificationSender(userIds, action);
            break;
        
        case 'CONNECTION_CLOSED':
            // the user just closed the connection.
            userIds = 'connected';
            notificationSender(userIds, action);
            break;
            
        case 'GIFT_CREATED':
            userIds = 'connected';
            notificationSender(userIds, action);
            break;
            
        case 'GIFT_CREATE_ERROR':
            userIds = ws.data.user._id;
            notificationSender(userIds, action);
        /*
        case 'USER_UPDATED':

            break;

        case 'USER_DELETED':

            break;
        */
    }
};

const notificationSender = (userIds, action) => {
    console.log('Trying to send notification type: '+action.type+' to users: '+userIds);
    
    // loop through all connected and subscribed
    if (userIds === 'all') {
        for (let [userId, ws] of it(currentConnections)) {
            ws.send(JSON.stringify(action));
        }

        for (let [userId, subscription] of it(currentPushSubscriptions)) {
            // TODO: send notification to FCM via XMPP request...
        }
    }
    // loop through all connected
    else if (userIds === 'connected') {
        for (let [userId, ws] of it(currentConnections)) {
            ws.send(JSON.stringify(action));
        }
    }
    // must be an array, lets send to specific users
    else {
        for (let uid in userIds) {
            let uid = userIds[uid];

            // first check for this user in currentConnections to see if we can notify them via a websocket.
            if (currentConnections.hasOwnProperty(uid)) {
                console.log('Found uid: '+uid+' in current connections');
                currentConnections[uid].send(JSON.stringify(notification));
            }

            // if they aren't in there lets see if they are a Push subscriber, maybe we can contact them that way.
            else if (currentPushSubscriptions.hasOwnProperty(uid)) {
                console.log('Found uid: '+uid+' in push subscriptions');
                //TODO: send notification to FCM via XMPP request...
            }

            // this user is not reachable :(
            else {
                console.log('User: '+uid+' is unreachable :(');
                //TODO: maybe do something here in the future...
            }
        }
    }
    
    console.log(''); //create an extra line seperation in logs
};