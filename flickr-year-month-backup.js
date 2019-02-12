var habitat = require("habitat"),
    env = habitat.load(),
    Flickr = require('flickrapi'),
    fs = require('fs'),
    https = require('https'),
    glob = require('glob'),
    FlickrOptions = env.get("FLICKR");

var photoSavedIds = [];
glob(FlickrOptions.backup_dir +  '/*/*/*', {}, (err, files)=>{
  photoSavedIds = files.map((filename) => filename.replace(/^.*[\\\/]/, '').slice(0,-4));
});

function setBaseOptions(flickr, result, options)
{
    options.api_key = flickr.options.api_key;
    options.user_id = flickr.options.user_id;
    options.authenticated = true;
    return options;
}

function setLastResult(flickr, result, options)
{
    options.result = result;
    return options;
}

function createDirectoryIfDoesNotExist(dir)
{
    if (!fs.existsSync(dir)){
        fs.mkdirSync(dir);
    }
}

/**
 * Check whether or not the JPG ends in 0xFFD9.
 */
function validateJPG(file, cb) {
    var data = fs.readFileSync(file),
        len = data.length,
        last = data.slice(len-2,len),
        ends = (last[0] === 0xFF && last[1] === 0xD9);
    cb(ends ? false : "jpg file "+file+" is incomplete.");
}

/**
 * Check whether the png file has an IEND block.
 */
function validatePNG(file, cb) {
    var data = fs.readFileSync(file),
        ends = data.toString().indexOf("IEND") > -1;
    cb(ends ? false : "png file "+file+" is incomplete.");
}

/**
 * Validate a downloaded jpg/png file
 */
function validateFile(dest, cb) {
    if(dest.indexOf(".jpg") > -1 || dest.indexOf(".JPG") > -1) {
        validateJPG(dest, cb);
    }
    else if(dest.indexOf(".png") > -1 || dest.indexOf(".PNG") > -1) {
        validatePNG(dest, cb);
    }
    // no idea how to validate. So just claim it's fine.
    else { cb(false); }
}
/**
 * Retrieve image resources from the web
 */
function getFromURL(url, dest, retries, handler) {

    if (retries > 5) {
        var err = "Maximum number of retries reached for " + dest;
        console.error(err);
        return handler ? handler(err) : false;
    }

    var file = fs.createWriteStream(dest),
        handleRequest = function(response) {
            response.pipe(file);
            file.on('finish', function() {
                    file.close();
                    validateFile(dest, function(err) {
                        if(err) {
                            console.error(err);
                            retries++;
                            return getFromURL(url, dest, retries, handler);
                        }
                    });
                    handler();
            });
        },
        errorHandler = function(err) {
            console.error(err);
            handler(err);
        };
    https.get(url, handleRequest).on('error', errorHandler);
}

Flickr.authenticate(FlickrOptions, function(error, flickr) {

    var util = require('util');

    var actualPhotoMetaData = {
        baseDir: flickr.options.backup_dir,
        pageIndex: 1,
        photoCounter: -1,
        photoIndex: 0,
        perPage: 100,
        failure: false,
        skip: false
    };

    function nextPhoto(result, call)
    {
        if(! actualPhotoMetaData.failure)
        {
            ++actualPhotoMetaData.photoCounter;
        }
        else
        {
            actualPhotoMetaData.failure = false;
        }
        var photoNumber = actualPhotoMetaData.photoCounter;
        actualPhotoMetaData.pageIndex = Math.floor((photoNumber / actualPhotoMetaData.perPage) + 1);
        actualPhotoMetaData.photoIndex = photoNumber % actualPhotoMetaData.perPage;

        call();
    }

    function setActualPage(flickr, result, options)
    {
        //console.log("Set actual page: ", actualPhotoMetaData.pageIndex);
        options.page = actualPhotoMetaData.pageIndex;
        return options;
    }

    function isNewPage()
    {
        //console.log("Is new page?",actualPhotoMetaData.photoIndex);
        return (actualPhotoMetaData.photoIndex == 0);
    }

    function processOldPage(result, nextCall)
    {
        //console.log("process old page");
        nextCall(undefined, actualPhotoMetaData.oldPage);
    }

    function setActualPhotoId(result)
    {
        if(actualPhotoMetaData.photoCounter >= result.photos.total)
        {
            process.exit();
        }
        actualPhotoMetaData.id = result.photos.photo[actualPhotoMetaData.photoIndex].id;
        console.log("Processing photo ", actualPhotoMetaData.id,  actualPhotoMetaData.photoCounter + 1, "/", result.photos.total);
        var cacheIndex = photoSavedIds.indexOf(actualPhotoMetaData.id);
        if(cacheIndex != -1)
        {
            console.log("Photo", actualPhotoMetaData.path, "already exists. Found in cache. index:", cacheIndex);
            //console.log("Skip was set.");
            actualPhotoMetaData.skip=true;
        }
        if(actualPhotoMetaData.oldPage === undefined || result.photos.page != actualPhotoMetaData.oldPage.photos.page)
        {
            //console.log("Set next page:", result.photos.page);
            //console.log(result.photos.photo[99]);
            actualPhotoMetaData.oldPage = result;
            //console.log(actualPhotoMetaData.oldPage.photos.photo[99]);
        }
        actualPhotoMetaData.perPage = result.photos.perpage;
    }

    function setPhotoId(flickr, result, options)
    {
        options.photo_id = actualPhotoMetaData.id;
        return options;
    }


    function prepareFilePath(result)
    {
        //console.log(result);
        actualPhotoMetaData.fileName = result.photo.id;
        actualPhotoMetaData.fileName += "." + result.photo.originalformat;
        actualPhotoMetaData.taken = result.photo.dates.taken;
        const year = actualPhotoMetaData.taken.substring(0,4);
        const yearMonth = actualPhotoMetaData.taken.substring(0,7);
        actualPhotoMetaData.path = actualPhotoMetaData.baseDir + "/" + year;
        createDirectoryIfDoesNotExist(actualPhotoMetaData.path);
        actualPhotoMetaData.path += "/" + yearMonth;
        createDirectoryIfDoesNotExist(actualPhotoMetaData.path);
        actualPhotoMetaData.path += "/" + actualPhotoMetaData.fileName;

    }

    function printActualPhotoMetaData(result)
    {
        console.log(actualPhotoMetaData);
        console.log(result.sizes.size.slice(-1)[0]);
    }

    function getPhoto(result, nextCall)
    {
        if(result === undefined)
        {
            nextCall("Result is undefined");
            return;
        }
        actualPhotoMetaData.url = result.sizes.size.slice(-1)[0].source;
        if (fs.existsSync(actualPhotoMetaData.path))
        {
            console.log("Photo", actualPhotoMetaData.path, "already exists. Found in filesystem.");
            nextCall();
        }
        else
        {
            getFromURL(actualPhotoMetaData.url, actualPhotoMetaData.path, 0, nextCall);
        }
    }

    function resultProcessor(call)
    {
        return {
               getParams: pipeParamConstruction(setLastResult),
               execute: (params, nextCall) => 
               { 
                    var error = params.result === undefined;
                    if(! error)
                    {
                        call(params.result); 
                    }
                    nextCall(error ? "Result is undefined." : false, params.result); 
               }
        };
    }
    function resultProcessorCallback(call)
   { 
        return {
               getParams: pipeParamConstruction(setLastResult),
               execute: (params, nextCall) => 
               { 
                  call(params.result, nextCall); 
               }
        };
    }
    function flickrCall(call, ...paramSetters)
    {
        return {
               getParams: pipeParamConstruction(...paramSetters),
               execute: call
        };
    }
    function flickrCallIf(statement, callTrue, callFalse, ...paramSetters)
    {
        return {
               getParams: pipeParamConstruction(...paramSetters),
               execute: (params, nextCall) => {
                if(statement())
                { 
                    //console.log("Call true");
                    console.log(params);
                    //var wrappedNextCall = (err, result) => { console.log(result); nextCall(err, result); };
                    callTrue(params, nextCall);
                }
                else
                {
                    callFalse(params, nextCall);
                }
              }
        };
    }

    var composeFlickrCalls = (...functionObjects) => (lastCall) =>  functionObjects.reduceRight((nextCall, functionObject) =>
    {
        return function(err, result)
        {
               if(err !== undefined && err != false)
               {
                    console.log("Error: ", err);
                    actualPhotoMetaData.failure = true;
                    return lastCall();
               }
               if(actualPhotoMetaData.skip)
               {
                    //console.log("Skip was reset.");
                    actualPhotoMetaData.skip = false;
                    return lastCall();
               }
               functionObject.execute(functionObject.getParams(flickr, result), nextCall);
        };
    }, lastCall);

    var pipeParamConstruction = (...functions) => (flickr, params) => functions.reduce((options, call) => call(flickr, params, options), {});

    console.log("Starting backup")

    var exec = composeFlickrCalls(
    resultProcessorCallback(nextPhoto),
    flickrCallIf(isNewPage, flickr.photos.search, processOldPage,  setBaseOptions, setActualPage),
    resultProcessor(setActualPhotoId),
    flickrCall(flickr.photos.getInfo, setBaseOptions, setPhotoId),
    resultProcessor(prepareFilePath),
    flickrCall(flickr.photos.getSizes, setBaseOptions, setPhotoId),
    resultProcessorCallback(getPhoto)
    );

    function lastCall(err, result)
    {   
        exec(lastCall)();
    }

    exec(lastCall)();

});
